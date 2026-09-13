package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1/bifurcationv1connect"
	"github.com/Zxilly/bifurcation/services/daemon/internal/identity"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	"github.com/Zxilly/bifurcation/services/daemon/internal/system"
	"google.golang.org/protobuf/proto"
)

type maintenancePanel struct {
	bifurcationv1connect.UnimplementedMachineServiceHandler
	mu               sync.Mutex
	token, artifact  string
	taskID, hash     string
	payload          []byte
	kind             v1.TaskKind
	report           *v1.ReportTaskRequest
	version          string
	sessions         int64
	notify           chan struct{}
	offline          atomic.Bool
	rejectAuth       atomic.Bool
	rejectAtHandoff  bool
	offlineAtHandoff bool
	loseFinalACK     bool
	withholdFinalACK atomic.Bool
	finalAttempts    int
}

func (p *maintenancePanel) WatchTasks(ctx context.Context, request *connect.Request[v1.WatchTasksRequest], stream *connect.ServerStream[v1.WatchTasksResponse]) error {
	if request.Header().Get("Authorization") != "Bearer "+p.token {
		return connect.NewError(connect.CodeUnauthenticated, errors.New("invalid fixture token"))
	}
	epoch := atomic.AddInt64(&p.sessions, 1)
	if err := stream.Send(&v1.WatchTasksResponse{Event: &v1.WatchTasksResponse_Session{Session: &v1.SessionOpened{MachineId: "fixture-machine", BindingEpoch: 1, SessionEpoch: epoch, HeartbeatSeconds: 1, StatusIntervalSeconds: 5}}}); err != nil {
		return err
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	announced := ""
	for {
		p.mu.Lock()
		id, hash, kind := p.taskID, p.hash, p.kind
		terminal := p.report != nil && (p.report.State == v1.TaskState_TASK_STATE_SUCCEEDED || p.report.State == v1.TaskState_TASK_STATE_FAILED)
		p.mu.Unlock()
		if id != "" && id != announced && !terminal {
			announced = id
			if err := stream.Send(&v1.WatchTasksResponse{Event: &v1.WatchTasksResponse_Task{Task: &v1.TaskAvailable{TaskId: id, PayloadSha256: hash, Kind: kind}}}); err != nil {
				return err
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-p.notify:
		case <-ticker.C:
			if err := stream.Send(&v1.WatchTasksResponse{Event: &v1.WatchTasksResponse_Heartbeat{Heartbeat: &v1.Heartbeat{ServerTimeUnixMs: time.Now().UnixMilli()}}}); err != nil {
				return err
			}
		}
	}
}
func (p *maintenancePanel) AcceptTask(context.Context, *connect.Request[v1.AcceptTaskRequest]) (*connect.Response[v1.AcceptTaskResponse], error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return connect.NewResponse(&v1.AcceptTaskResponse{TaskId: p.taskID, BindingEpoch: 1, Kind: p.kind, Payload: p.payload, PayloadSha256: p.hash}), nil
}
func (p *maintenancePanel) ReportStatus(_ context.Context, request *connect.Request[v1.ReportStatusRequest]) (*connect.Response[v1.ReportStatusResponse], error) {
	p.mu.Lock()
	p.version = request.Msg.Status.DaemonVersion
	p.mu.Unlock()
	return connect.NewResponse(&v1.ReportStatusResponse{CommittedSequence: request.Msg.Sequence}), nil
}
func (p *maintenancePanel) ReportTask(_ context.Context, request *connect.Request[v1.ReportTaskRequest]) (*connect.Response[v1.ReportTaskResponse], error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	terminal := request.Msg.State == v1.TaskState_TASK_STATE_SUCCEEDED || request.Msg.State == v1.TaskState_TASK_STATE_FAILED
	if p.report == nil || request.Msg.Sequence > p.report.Sequence {
		p.report = proto.Clone(request.Msg).(*v1.ReportTaskRequest)
	}
	if p.rejectAtHandoff && request.Msg.Phase == "updater_ready" {
		p.rejectAuth.Store(true)
	}
	if p.offlineAtHandoff && request.Msg.Phase == "updater_ready" {
		p.offline.Store(true)
	}
	if terminal {
		p.finalAttempts++
		if p.withholdFinalACK.Load() || p.loseFinalACK && p.finalAttempts == 1 {
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("lost final ACK after commit"))
		}
	}
	return connect.NewResponse(&v1.ReportTaskResponse{CommittedSequence: request.Msg.Sequence, Terminal: terminal}), nil
}
func (p *maintenancePanel) enqueue(id string, kind v1.TaskKind, spec *v1.TaskSpec) error {
	payload, err := proto.Marshal(spec)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(payload)
	p.mu.Lock()
	p.taskID = id
	p.kind = kind
	p.payload = payload
	p.hash = hex.EncodeToString(sum[:])
	p.report = nil
	p.mu.Unlock()
	select {
	case p.notify <- struct{}{}:
	default:
	}
	return nil
}
func disposableSystemd(t *testing.T) (string, string) {
	t.Helper()
	if runtime.GOOS != "linux" || os.Getenv("BIFURCATION_DISPOSABLE_SYSTEMD_TEST") != "1" {
		t.Skip("requires an explicitly disposable systemd Linux container")
	}
	if _, err := os.Stat("/.dockerenv"); err != nil {
		t.Fatal("refusing destructive service fixtures outside Docker")
	}
	oldBinary, newBinary := os.Getenv("BIFURCATION_TEST_OLD"), os.Getenv("BIFURCATION_TEST_NEW")
	if oldBinary == "" || newBinary == "" {
		t.Fatal("old and new daemon fixtures are required")
	}
	return oldBinary, newBinary
}
func eventually(t *testing.T, timeout time.Duration, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal(description)
}
func systemctl(t *testing.T, args ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if output, err := exec.CommandContext(ctx, "systemctl", args...).CombinedOutput(); err != nil {
		t.Fatalf("systemctl %v: %v %s", args, err, output)
	}
}
func setupMaintenance(t *testing.T, oldBinary, artifact string) (*maintenancePanel, string, string) {
	t.Helper()
	directory := t.TempDir()
	if base := os.Getenv("BIFURCATION_TEST_STATE_BASE"); base != "" {
		if err := os.MkdirAll(base, 0700); err != nil {
			t.Fatal(err)
		}
		created, err := os.MkdirTemp(base, t.Name()+"-")
		if err != nil {
			t.Fatal(err)
		}
		directory = created
		t.Cleanup(func() { _ = os.RemoveAll(created) })
	}
	configPath := filepath.Join(directory, "daemon.json")
	stateDirectory := filepath.Join(directory, "state")
	panel := &maintenancePanel{token: "maintenance-fixture-token", artifact: artifact, notify: make(chan struct{}, 8)}
	path, handler := bifurcationv1connect.NewMachineServiceHandler(panel)
	mux := http.NewServeMux()
	mux.Handle("/rpc"+path, http.StripPrefix("/rpc", handler))
	mux.HandleFunc("/candidate", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, panel.artifact) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if panel.rejectAuth.Load() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"code":"unauthenticated","message":"fixture token rejected"}`))
			return
		}
		if panel.offline.Load() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"code":"unavailable","message":"fixture panel offline"}`))
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	if err := identity.WriteConfig(configPath, identity.Config{PanelURL: server.URL, Token: panel.token, StateDirectory: stateDirectory}, false); err != nil {
		t.Fatal(err)
	}
	if err := system.CopyAtomic(oldBinary, InstalledBinary, 0755); err != nil {
		t.Fatal(err)
	}
	if err := system.CopyAtomic(oldBinary, RecoveryBinary, 0755); err != nil {
		t.Fatal(err)
	}
	unit := "# Managed by Bifurcation installer v1\n[Unit]\nDescription=Bifurcation fixture daemon\n[Service]\nType=simple\nExecStartPre=" + RecoveryBinary + " -recover-update -config " + configPath + "\nExecStart=" + InstalledBinary + " -config " + configPath + "\nRestart=on-failure\nRestartSec=1\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n"
	if err := system.AtomicWrite(filepath.Join(unitDirectory, DaemonUnit), []byte(unit), 0644); err != nil {
		t.Fatal(err)
	}
	systemctl(t, "daemon-reload")
	systemctl(t, "enable", DaemonUnit)
	systemctl(t, "start", DaemonUnit)
	t.Cleanup(func() {
		_ = exec.Command("systemctl", "disable", DaemonUnit, UninstallUnit).Run()
		_ = exec.Command("systemctl", "stop", DaemonUnit, UninstallUnit).Run()
		panel.mu.Lock()
		taskID := panel.taskID
		panel.mu.Unlock()
		if taskID != "" {
			_ = exec.Command("systemctl", "stop", "bifurcation-update-"+taskID+".service").Run()
		}
		_ = os.Remove(filepath.Join(unitDirectory, DaemonUnit))
		_ = os.Remove(filepath.Join(unitDirectory, UninstallUnit))
		_ = os.Remove(InstalledBinary)
		_ = os.Remove(RecoveryBinary)
		_ = exec.Command("systemctl", "daemon-reload").Run()
	})
	eventually(t, 15*time.Second, "old daemon did not connect", func() bool { panel.mu.Lock(); defer panel.mu.Unlock(); return panel.version == "0.0.0-dev" })
	return panel, server.URL, stateDirectory
}
func artifactFor(t *testing.T, path, url string) *v1.Artifact {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := system.FileSHA256(path)
	if err != nil {
		t.Fatal(err)
	}
	return &v1.Artifact{Id: "daemon-test", Version: "0.1.0", Url: url + "/candidate", Sha256: digest, SizeBytes: info.Size(), Os: "linux", Arch: runtime.GOARCH}
}
func TestRealSystemdDaemonUpgradeSurvivesPanelOutage(t *testing.T) {
	oldBinary, newBinary := disposableSystemd(t)
	panel, url, directory := setupMaintenance(t, oldBinary, newBinary)
	panel.offlineAtHandoff = true
	if err := panel.enqueue("upgrade-offline", v1.TaskKind_TASK_KIND_UPGRADE_DAEMON, &v1.TaskSpec{Operation: &v1.TaskSpec_UpgradeDaemon{UpgradeDaemon: &v1.UpgradeDaemonTask{Artifact: artifactFor(t, newBinary, url)}}}); err != nil {
		t.Fatal(err)
	}
	eventually(t, 70*time.Second, "candidate did not become locally healthy while panel was offline", func() bool {
		data, err := os.ReadFile(filepath.Join(directory, "updater", "upgrade.json"))
		if err != nil {
			return false
		}
		var plan Plan
		if json.Unmarshal(data, &plan) != nil {
			return false
		}
		return plan.Phase == "local_healthy" || plan.Phase == "result_pending_ack"
	})
	output, err := exec.Command(InstalledBinary, "-version").Output()
	if err != nil || strings.TrimSpace(string(output)) != "0.1.0" {
		t.Fatalf("network outage rolled back a healthy candidate: %s %v", output, err)
	}
	panel.offline.Store(false)
	eventually(t, 40*time.Second, "upgrade final result was not acknowledged after reconnect", func() bool {
		panel.mu.Lock()
		defer panel.mu.Unlock()
		return panel.report != nil && panel.report.State == v1.TaskState_TASK_STATE_SUCCEEDED
	})
	store, err := state.Open(context.Background(), filepath.Join(directory, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	eventually(t, 10*time.Second, "terminal journal was not acknowledged", func() bool {
		task, e := store.Task(context.Background(), "upgrade-offline")
		return e == nil && task.Acknowledged
	})
}
func TestRealSystemdFailedCandidateRollsBackWithoutRestoringDatabase(t *testing.T) {
	oldBinary, newBinary := disposableSystemd(t)
	bad := os.Getenv("BIFURCATION_TEST_BAD")
	if bad == "" {
		t.Skip("set BIFURCATION_TEST_BAD to the compiled testdata/bad_start executable")
	}
	_ = newBinary
	panel, url, directory := setupMaintenance(t, oldBinary, bad)
	if err := panel.enqueue("upgrade-bad", v1.TaskKind_TASK_KIND_UPGRADE_DAEMON, &v1.TaskSpec{Operation: &v1.TaskSpec_UpgradeDaemon{UpgradeDaemon: &v1.UpgradeDaemonTask{Artifact: artifactFor(t, bad, url)}}}); err != nil {
		t.Fatal(err)
	}
	eventually(t, 20*time.Second, "candidate was not switched for the actual startup failure", func() bool {
		installed, e := system.FileSHA256(InstalledBinary)
		expected, _ := system.FileSHA256(bad)
		return e == nil && installed == expected
	})
	store, err := state.Open(context.Background(), filepath.Join(directory, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	id, err := identity.Load(directory)
	if err != nil {
		t.Fatal(err)
	}
	streamID := "usage-" + id.InstallationID
	for _, counter := range []state.Counter{{UserID: "fixture-user", RuntimeID: "fixture-counter-source", ObservedAt: 1}, {UserID: "fixture-user", RuntimeID: "fixture-counter-source", ObservedAt: 2, Upload: 123}} {
		if _, err = store.RecordSample(context.Background(), streamID, []state.Counter{counter}); err != nil {
			t.Fatal(err)
		}
	}
	original, err := store.NextBatch(context.Background(), streamID)
	if err != nil || original == nil {
		t.Fatal("usage persistence fixture failed", err)
	}
	eventually(t, 75*time.Second, "failed candidate was not rolled back", func() bool {
		panel.mu.Lock()
		defer panel.mu.Unlock()
		return panel.report != nil && panel.report.State == v1.TaskState_TASK_STATE_FAILED && panel.report.Rollback == v1.RollbackState_ROLLBACK_STATE_SUCCEEDED
	})
	output, err := exec.Command(InstalledBinary, "-version").Output()
	if err != nil || strings.TrimSpace(string(output)) != "0.0.0-dev" {
		t.Fatalf("old binary was not restored: %s %v", output, err)
	}
	retained, err := store.NextBatch(context.Background(), streamID)
	if err != nil || retained == nil || retained.Hash != original.Hash {
		t.Fatal("binary rollback lost a newly persisted outbox batch", err)
	}
}
func TestRealSystemdUninstallKeepsIdentityUntilFinalACK(t *testing.T) {
	oldBinary, newBinary := disposableSystemd(t)
	panel, _, directory := setupMaintenance(t, oldBinary, newBinary)
	coreCache := filepath.Join(directory, "core", "cache.db")
	if err := os.MkdirAll(filepath.Dir(coreCache), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(coreCache, []byte("owned core cache"), 0600); err != nil {
		t.Fatal(err)
	}
	unrelated := filepath.Join(directory, "keep.txt")
	if err := os.WriteFile(unrelated, []byte("operator file"), 0600); err != nil {
		t.Fatal(err)
	}
	panel.withholdFinalACK.Store(true)
	if err := panel.enqueue("uninstall", v1.TaskKind_TASK_KIND_UNINSTALL, &v1.TaskSpec{Operation: &v1.TaskSpec_Uninstall{Uninstall: &v1.UninstallTask{}}}); err != nil {
		t.Fatal(err)
	}
	eventually(t, 30*time.Second, "uninstall did not reach its final result", func() bool {
		panel.mu.Lock()
		defer panel.mu.Unlock()
		return panel.finalAttempts >= 1 && panel.report != nil && panel.report.State == v1.TaskState_TASK_STATE_SUCCEEDED
	})
	data, err := os.ReadFile(filepath.Join(directory, "updater", "uninstall.json"))
	if err != nil {
		t.Fatal(err)
	}
	var plan Plan
	if err = json.Unmarshal(data, &plan); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(directory, "identity.json"), filepath.Join(directory, "state.db"), plan.ConfigPath, plan.Helper, filepath.Join(unitDirectory, UninstallUnit)} {
		if _, err = os.Stat(path); err != nil {
			t.Fatalf("recovery dependency was removed before ACK: %s: %v", path, err)
		}
	}
	systemctl(t, "is-enabled", UninstallUnit)
	// The daemon service and binary may already be gone. Its separately enabled
	// helper must still restart solely from the retained recovery dependencies.
	systemctl(t, "restart", UninstallUnit)
	panel.mu.Lock()
	attemptsAfterRestart := panel.finalAttempts
	panel.mu.Unlock()
	eventually(t, 15*time.Second, "restarted persistent helper did not replay its final result", func() bool {
		panel.mu.Lock()
		defer panel.mu.Unlock()
		return panel.finalAttempts > attemptsAfterRestart
	})
	panel.withholdFinalACK.Store(false)
	eventually(t, 15*time.Second, "acknowledged uninstall did not remove identity and daemon binary", func() bool {
		_, idErr := os.Stat(filepath.Join(directory, "identity.json"))
		_, binaryErr := os.Stat(InstalledBinary)
		_, unitErr := os.Stat(filepath.Join(unitDirectory, DaemonUnit))
		return errors.Is(idErr, os.ErrNotExist) && errors.Is(binaryErr, os.ErrNotExist) && errors.Is(unitErr, os.ErrNotExist)
	})
	eventually(t, 5*time.Second, "acknowledged uninstall retained the embedded core cache", func() bool {
		_, err := os.Stat(coreCache)
		return errors.Is(err, os.ErrNotExist)
	})
	if data, err := os.ReadFile(unrelated); err != nil || string(data) != "operator file" {
		t.Fatal("uninstall removed an unrelated operator file", err)
	}
}

func TestRealSystemdAuthenticationRejectionKeepsHealthyNewBinary(t *testing.T) {
	oldBinary, newBinary := disposableSystemd(t)
	panel, url, directory := setupMaintenance(t, oldBinary, newBinary)
	panel.rejectAtHandoff = true
	if err := panel.enqueue("upgrade-auth", v1.TaskKind_TASK_KIND_UPGRADE_DAEMON, &v1.TaskSpec{Operation: &v1.TaskSpec_UpgradeDaemon{UpgradeDaemon: &v1.UpgradeDaemonTask{Artifact: artifactFor(t, newBinary, url)}}}); err != nil {
		t.Fatal(err)
	}
	eventually(t, 35*time.Second, "authentication rejection was mistaken for a defective candidate", func() bool {
		data, err := os.ReadFile(filepath.Join(directory, "updater", "upgrade.json"))
		if err != nil {
			return false
		}
		var plan Plan
		if json.Unmarshal(data, &plan) != nil {
			return false
		}
		return plan.LocalIssue != "" && (plan.Phase == "local_healthy" || plan.Phase == "result_pending_ack")
	})
	output, err := exec.Command(InstalledBinary, "-version").Output()
	if err != nil || strings.TrimSpace(string(output)) != "0.1.0" {
		t.Fatalf("401 caused binary rollback: %s %v", output, err)
	}
	panel.rejectAuth.Store(false)
	eventually(t, 30*time.Second, "credential recovery did not deliver the retained upgrade result", func() bool {
		panel.mu.Lock()
		defer panel.mu.Unlock()
		return panel.report != nil && panel.report.State == v1.TaskState_TASK_STATE_SUCCEEDED && strings.Contains(panel.report.Message, "credentials")
	})
}

// This second phase is run after an external docker restart interrupted the bad
// candidate test, proving recovery without that test process or transient unit.
func TestRecoveredAfterContainerRestart(t *testing.T) {
	configPath := os.Getenv("BIFURCATION_REBOOT_CONFIG")
	if configPath == "" {
		t.Skip("set the persisted reboot fixture configuration after restarting its container")
	}
	disposableSystemd(t)
	config, err := identity.LoadConfig(configPath)
	if err != nil {
		t.Fatal(err)
	}
	store, err := state.Open(context.Background(), filepath.Join(config.StateDirectory, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	eventually(t, 20*time.Second, "retained helper did not confirm old daemon startup after reboot", func() bool {
		task, e := store.Task(context.Background(), "upgrade-bad")
		return e == nil && task.Status == "failed"
	})
	task, err := store.Task(context.Background(), "upgrade-bad")
	if err != nil {
		t.Fatal(err)
	}
	var result v1.ReportTaskRequest
	if err = proto.Unmarshal(task.Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.Phase != "rolled_back" || result.Rollback != v1.RollbackState_ROLLBACK_STATE_SUCCEEDED || result.ErrorCode != "UPDATE_INTERRUPTED" || task.Acknowledged {
		t.Fatalf("unexpected recovered result: %+v acknowledged=%v", &result, task.Acknowledged)
	}
	output, err := exec.Command(InstalledBinary, "-version").Output()
	if err != nil || strings.TrimSpace(string(output)) != "0.0.0-dev" {
		t.Fatal("known-good binary was not restored", err)
	}
	id, err := identity.Load(config.StateDirectory)
	if err != nil {
		t.Fatal(err)
	}
	batch, err := store.NextBatch(context.Background(), "usage-"+id.InstallationID)
	if err != nil || batch == nil {
		t.Fatal("reboot recovery lost the new outbox", err)
	}
	var usage v1.UsageBatch
	if err = proto.Unmarshal(batch.Payload, &usage); err != nil || len(usage.Deltas) != 1 || usage.Deltas[0].UploadBytes != 123 {
		t.Fatal("outbox changed across reboot", err)
	}
	t.Logf("restored=0.0.0-dev task=%s phase=%s ack=%v retained_seq=%d upload=%d", task.ID, result.Phase, task.Acknowledged, batch.Seq, usage.Deltas[0].UploadBytes)
}
