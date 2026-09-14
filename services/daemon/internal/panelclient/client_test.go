package panelclient

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1/bifurcationv1connect"
	"github.com/Zxilly/bifurcation/services/daemon/internal/identity"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	"github.com/Zxilly/bifurcation/services/daemon/internal/updater"
	"google.golang.org/protobuf/proto"
)

type testPanel struct {
	bifurcationv1connect.UnimplementedMachineServiceHandler
	mu        sync.Mutex
	payload   []byte
	hash      string
	reports   []*v1.ReportTaskRequest
	sessions  int
	accepted  int
	done      chan struct{}
	ackLost   bool
	status    *v1.MachineStatus
	supported []v1.TaskKind
}

func (p *testPanel) WatchTasks(ctx context.Context, r *connect.Request[v1.WatchTasksRequest], stream *connect.ServerStream[v1.WatchTasksResponse]) error {
	if r.Header().Get("Authorization") != "Bearer secret" {
		return connect.NewError(connect.CodeUnauthenticated, errors.New("missing token"))
	}
	p.mu.Lock()
	p.sessions++
	p.supported = append([]v1.TaskKind(nil), r.Msg.SupportedTasks...)
	epoch := int64(p.sessions)
	p.mu.Unlock()
	if err := stream.Send(&v1.WatchTasksResponse{Event: &v1.WatchTasksResponse_Session{Session: &v1.SessionOpened{MachineId: "machine", BindingEpoch: 1, SessionEpoch: epoch, HeartbeatSeconds: 15, StatusIntervalSeconds: 10}}}); err != nil {
		return err
	}
	// Repeated delivery is intentional; after the lost ACK the next session replays it.
	for range 2 {
		if err := stream.Send(&v1.WatchTasksResponse{Event: &v1.WatchTasksResponse_Task{Task: &v1.TaskAvailable{TaskId: "inspect", PayloadSha256: p.hash, Kind: v1.TaskKind_TASK_KIND_INSPECT}}}); err != nil {
			return err
		}
	}
	<-ctx.Done()
	return ctx.Err()
}
func (p *testPanel) AcceptTask(ctx context.Context, r *connect.Request[v1.AcceptTaskRequest]) (*connect.Response[v1.AcceptTaskResponse], error) {
	p.mu.Lock()
	p.accepted++
	p.mu.Unlock()
	return connect.NewResponse(&v1.AcceptTaskResponse{TaskId: "inspect", BindingEpoch: 1, Kind: v1.TaskKind_TASK_KIND_INSPECT, Payload: p.payload, PayloadSha256: p.hash}), nil
}
func (p *testPanel) ReportStatus(_ context.Context, r *connect.Request[v1.ReportStatusRequest]) (*connect.Response[v1.ReportStatusResponse], error) {
	p.mu.Lock()
	p.status = proto.Clone(r.Msg.Status).(*v1.MachineStatus)
	p.mu.Unlock()
	return connect.NewResponse(&v1.ReportStatusResponse{}), nil
}
func (p *testPanel) ReportTask(ctx context.Context, r *connect.Request[v1.ReportTaskRequest]) (*connect.Response[v1.ReportTaskResponse], error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if r.Msg.State == v1.TaskState_TASK_STATE_RUNNING {
		return connect.NewResponse(&v1.ReportTaskResponse{CommittedSequence: r.Msg.Sequence}), nil
	}
	p.reports = append(p.reports, proto.Clone(r.Msg).(*v1.ReportTaskRequest))
	if !p.ackLost {
		p.ackLost = true
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("ACK lost after commit"))
	}
	if len(p.reports) >= 3 {
		select {
		case <-p.done:
		default:
			close(p.done)
		}
	}
	return connect.NewResponse(&v1.ReportTaskResponse{CommittedSequence: r.Msg.Sequence, Terminal: true}), nil
}
func TestStreamingReconnectDuplicateDeliveryAndLostResultACK(t *testing.T) {
	payload, err := proto.Marshal(&v1.TaskSpec{Operation: &v1.TaskSpec_Inspect{Inspect: &v1.InspectTask{MaxBytes: 4096}}})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	panel := &testPanel{payload: payload, hash: hex.EncodeToString(sum[:]), done: make(chan struct{})}
	path, handler := bifurcationv1connect.NewMachineServiceHandler(panel)
	mux := http.NewServeMux()
	mux.Handle("/rpc"+path, http.StripPrefix("/rpc", handler))
	server := httptest.NewServer(mux)
	defer server.Close()
	dir := t.TempDir()
	id, err := identity.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	store, err := state.Open(context.Background(), filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	c := New(identity.Config{PanelURL: server.URL, Token: "secret", StateDirectory: dir}, id, store, "test", slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.SetMaintenance(updater.New(identity.Config{PanelURL: server.URL, StateDirectory: dir}, filepath.Join(dir, "daemon.json"), "test", store))
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- c.Run(ctx) }()
	select {
	case <-panel.done:
		cancel()
	case <-ctx.Done():
		t.Fatal("result was not recovered after disconnect")
	}
	<-result
	panel.mu.Lock()
	defer panel.mu.Unlock()
	if panel.sessions < 2 || len(panel.reports) < 3 {
		t.Fatal("reconnection and duplicate path were not exercised")
	}
	// A directly executed daemon (including this test process) must explain
	// why online maintenance is unavailable, without advertising the tasks.
	if panel.status == nil || panel.status.MaintenanceStatus == v1.MaintenanceStatus_MAINTENANCE_STATUS_UNSPECIFIED || panel.status.MaintenanceStatus == v1.MaintenanceStatus_MAINTENANCE_STATUS_AVAILABLE {
		t.Fatalf("missing installation-specific maintenance status: %v", panel.status)
	}
	for _, kind := range panel.supported {
		if kind == v1.TaskKind_TASK_KIND_UPGRADE_DAEMON || kind == v1.TaskKind_TASK_KIND_UNINSTALL {
			t.Fatalf("nonstandard installation advertised maintenance: %v", panel.supported)
		}
	}
	for _, r := range panel.reports {
		if r.Sequence != 2 || r.State != v1.TaskState_TASK_STATE_SUCCEEDED || string(r.DiagnosticJson) != string(panel.reports[0].DiagnosticJson) {
			t.Fatalf("task re-executed or result changed: %+v", r)
		}
	}
	persisted, err := store.Task(context.Background(), "inspect")
	if err != nil || persisted.ProgressSeq != 2 || !persisted.Acknowledged {
		t.Fatalf("final journal %+v %v", persisted, err)
	}
}
