package panelclient

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"os"
	"runtime"
	"time"

	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/internal/core"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	"github.com/Zxilly/bifurcation/services/daemon/internal/system"
	"github.com/Zxilly/bifurcation/services/daemon/internal/updater"
	"google.golang.org/protobuf/proto"
)

func (c *Client) execute(ctx context.Context, sessionEpoch int64, notice *v1.TaskAvailable) error {
	acceptCtx, cancelAccept := context.WithTimeout(ctx, 15*time.Second)
	response, err := c.rpc.AcceptTask(acceptCtx, request(c, &v1.AcceptTaskRequest{Installation: c.installation(), SessionEpoch: sessionEpoch, TaskId: notice.TaskId, PayloadSha256: notice.PayloadSha256}))
	cancelAccept()
	if err != nil {
		return err
	}
	accepted := response.Msg
	sum := sha256.Sum256(accepted.Payload)
	installation := c.installation()
	if accepted.TaskId != notice.TaskId || accepted.PayloadSha256 != notice.PayloadSha256 || hex.EncodeToString(sum[:]) != notice.PayloadSha256 || accepted.BindingEpoch != installation.BindingEpoch || accepted.Kind != notice.Kind {
		return state.ErrConflict
	}
	journal, err := c.store.Accept(ctx, state.Task{ID: accepted.TaskId, Hash: accepted.PayloadSha256, Kind: accepted.Kind.String(), Payload: accepted.Payload, BindingEpoch: accepted.BindingEpoch})
	if err != nil {
		return err
	}
	if journal.Status == "succeeded" || journal.Status == "failed" {
		return c.reportResult(ctx, journal)
	}
	if c.maintenance != nil && (accepted.Kind == v1.TaskKind_TASK_KIND_UPGRADE_DAEMON || accepted.Kind == v1.TaskKind_TASK_KIND_UNINSTALL) {
		active, e := c.maintenance.Active(journal.ID)
		if e != nil {
			return e
		}
		if active {
			return nil
		}
	}
	operationCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	journal, err = c.store.Transition(operationCtx, journal.ID, "running", nil)
	if err != nil {
		return err
	}
	report := &v1.ReportTaskRequest{Installation: installation, TaskId: journal.ID, PayloadSha256: journal.Hash, State: v1.TaskState_TASK_STATE_SUCCEEDED, Phase: "completed", Rollback: v1.RollbackState_ROLLBACK_STATE_NOT_NEEDED}
	// Running progress is persisted first. A failed network report cannot cancel accepted local work.
	progressCtx, stopProgress := context.WithTimeout(operationCtx, 5*time.Second)
	_, _ = c.rpc.ReportTask(progressCtx, request(c, &v1.ReportTaskRequest{Installation: installation, TaskId: journal.ID, PayloadSha256: journal.Hash, Sequence: journal.ProgressSeq, State: v1.TaskState_TASK_STATE_RUNNING, Phase: "running", Rollback: v1.RollbackState_ROLLBACK_STATE_NOT_NEEDED}))
	stopProgress()
	spec := new(v1.TaskSpec)
	if err = proto.Unmarshal(journal.Payload, spec); err != nil {
		report.ErrorCode = "INVALID_PAYLOAD"
		report.Message = "Task payload cannot be decoded"
	} else {
		switch accepted.Kind {
		case v1.TaskKind_TASK_KIND_INSPECT:
			if spec.GetInspect() == nil {
				err = errors.New("inspection payload is missing")
			} else {
				err = c.inspect(operationCtx, spec.GetInspect(), report)
			}
		case v1.TaskKind_TASK_KIND_UPGRADE_DAEMON:
			task := spec.GetUpgradeDaemon()
			if task == nil || task.Artifact == nil {
				err = errors.New("daemon upgrade artifact is missing")
				break
			}
			if c.maintenance == nil {
				err = core.ErrUnsupported
				break
			}
			artifact := task.Artifact
			err = c.maintenance.BeginUpgrade(operationCtx, journal, core.Artifact{Version: artifact.Version, URL: artifact.Url, SHA256: artifact.Sha256, OS: artifact.Os, Arch: artifact.Arch, SizeBytes: artifact.SizeBytes})
			if errors.Is(err, updater.ErrHandedOff) {
				return nil
			}
		case v1.TaskKind_TASK_KIND_UNINSTALL:
			task := spec.GetUninstall()
			if task == nil {
				err = errors.New("uninstall task payload is missing")
				break
			}
			if c.maintenance == nil {
				err = core.ErrUnsupported
				break
			}
			err = c.maintenance.BeginUninstall(operationCtx, journal)
			if errors.Is(err, updater.ErrHandedOff) {
				return nil
			}
		case v1.TaskKind_TASK_KIND_APPLY_CONFIG:
			task := spec.GetApplyConfig()
			if task == nil {
				err = errors.New("configuration task payload is missing")
				break
			}
			if c.core == nil {
				err = core.ErrUnsupported
				break
			}
			var config core.Configuration
			config, err = c.getConfig(operationCtx, journal.ID, task.RevisionId)
			if err != nil {
				break
			}
			if task.PolicyRevision != config.PolicyRevision {
				err = errors.New("task policy does not match immutable configuration")
				break
			}
			_ = c.collect(operationCtx)
			var result core.Result
			result, err = c.core.Apply(operationCtx, config)
			setRollback(report, result)
			if result.Health.Healthy {
				_ = c.collect(operationCtx)
			}
		default:
			err = core.ErrUnsupported
		}
		if err != nil {
			report.ErrorCode = taskErrorCode(err)
			if accepted.Kind == v1.TaskKind_TASK_KIND_UPGRADE_DAEMON {
				report.ErrorCode = "UPDATE_PREFLIGHT_FAILED"
			}
			if accepted.Kind == v1.TaskKind_TASK_KIND_UNINSTALL {
				report.ErrorCode = "UNINSTALL_PREPARATION_FAILED"
			}
			report.Message = err.Error()
		}
	}
	if report.ErrorCode != "" {
		report.State = v1.TaskState_TASK_STATE_FAILED
		report.Phase = "failed"
	}
	if len(report.Message) > 8192 {
		report.Message = system.LimitString(report.Message, 8192)
	}
	// Recovery must persist the terminal outcome even when shutdown canceled the operation.
	persistCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer stop()
	report.ActualStatus = c.status(persistCtx)
	latest, loadErr := c.store.Task(persistCtx, journal.ID)
	if loadErr != nil {
		return loadErr
	}
	journal = latest
	report.Sequence = journal.ProgressSeq + 1
	encoded, err := proto.Marshal(report)
	if err != nil {
		return err
	}
	status := "succeeded"
	if report.State == v1.TaskState_TASK_STATE_FAILED {
		status = "failed"
	}
	journal, err = c.store.Transition(persistCtx, journal.ID, status, encoded)
	if err != nil {
		return err
	}
	return c.reportResult(ctx, journal)
}
func (c *Client) getConfig(ctx context.Context, taskID, revisionID string) (core.Configuration, error) {
	callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	response, err := c.rpc.GetConfig(callCtx, request(c, &v1.GetConfigRequest{Installation: c.installation(), RevisionId: revisionID}))
	if err != nil {
		return core.Configuration{}, err
	}
	config := response.Msg
	if config.RevisionId != revisionID {
		return core.Configuration{}, state.ErrConflict
	}
	if len(config.Files) > 0 {
		return core.Configuration{}, errors.New("configuration file artifacts are not supported; use inline certificate data")
	}
	return core.Configuration{TaskID: taskID, RevisionID: config.RevisionId, SHA256: config.ConfigSha256, PolicyRevision: config.PolicyRevision, JSON: config.ConfigJson, Authorization: config.LatestAuthorizationJson, LatestPolicyRevision: config.LatestPolicyRevision}, nil
}
func (c *Client) inspect(ctx context.Context, inspection *v1.InspectTask, report *v1.ReportTaskRequest) error {
	hostname, _ := os.Hostname()
	diagnostic := map[string]any{"hostname": hostname, "os": runtime.GOOS, "arch": runtime.GOARCH, "daemonVersion": c.version, "installationId": c.installation().InstallationId, "observedAt": time.Now().UnixMilli()}
	if c.core != nil {
		health, err := c.core.Health(ctx)
		if err != nil {
			return err
		}
		diagnostic["core"] = health
	}
	if inspection.IncludeLogs {
		if c.core == nil {
			return core.ErrUnsupported
		}
		logs, err := c.core.ReadLogs(ctx, int(inspection.MaxLogLines), min(256<<10, int(inspection.MaxBytes)))
		if err != nil {
			return err
		}
		diagnostic["logs"] = logs
	}
	encoded, err := encodeDiagnostic(diagnostic, int(inspection.MaxBytes))
	if err != nil {
		return err
	}
	report.DiagnosticJson = encoded
	return nil
}
func encodeDiagnostic(diagnostic map[string]any, budget int) ([]byte, error) {
	if budget <= 0 || budget > 256<<10 {
		budget = 256 << 10
	}
	encoded, err := json.Marshal(diagnostic)
	if err != nil {
		return nil, err
	}
	if len(encoded) <= budget {
		return encoded, nil
	}
	logs, ok := diagnostic["logs"].(core.LogResult)
	if !ok || len(logs.Lines) == 0 {
		return nil, errors.New("diagnostic metadata exceeds requested limit")
	}
	original := logs.Lines
	low, high := 0, len(original)-1
	for low < high {
		count := (low + high + 1) / 2
		candidate := logs
		candidate.Lines = original[len(original)-count:]
		candidate.Truncated = true
		diagnostic["logs"] = candidate
		body, e := json.Marshal(diagnostic)
		if e != nil {
			return nil, e
		}
		if len(body) <= budget {
			low = count
		} else {
			high = count - 1
		}
	}
	logs.Lines = original[len(original)-low:]
	logs.Truncated = true
	diagnostic["logs"] = logs
	encoded, err = json.Marshal(diagnostic)
	if err != nil {
		return nil, err
	}
	if len(encoded) > budget {
		return nil, errors.New("diagnostic metadata exceeds requested limit")
	}
	return encoded, nil
}

func setRollback(report *v1.ReportTaskRequest, result core.Result) {
	switch result.Rollback {
	case "succeeded":
		report.Rollback = v1.RollbackState_ROLLBACK_STATE_SUCCEEDED
	case "failed":
		report.Rollback = v1.RollbackState_ROLLBACK_STATE_FAILED
	}
}
func taskErrorCode(err error) string {
	switch {
	case errors.Is(err, core.ErrStalePolicy):
		return "STALE_POLICY"
	case errors.Is(err, core.ErrUnsupported):
		return "UNSUPPORTED_TASK"
	case errors.Is(err, core.ErrNotConfigured):
		return "CORE_NOT_CONFIGURED"
	default:
		return "CORE_OPERATION_FAILED"
	}
}
func (c *Client) reportResult(ctx context.Context, journal state.Task) error {
	report := new(v1.ReportTaskRequest)
	if err := proto.Unmarshal(journal.Result, report); err != nil {
		return err
	}
	report.Installation = c.installation()
	callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	response, err := c.rpc.ReportTask(callCtx, request(c, report))
	if err != nil {
		return err
	}
	if !response.Msg.Terminal || response.Msg.CommittedSequence != journal.ProgressSeq {
		return state.ErrConflict
	}
	if err := c.store.AcknowledgeTask(ctx, journal.ID, journal.ProgressSeq); err != nil {
		return err
	}
	if c.maintenance != nil {
		return c.maintenance.Acknowledge(journal.ID)
	}
	return nil
}
func (c *Client) flushResults(ctx context.Context) error {
	pending, err := c.store.PendingResults(ctx)
	if err != nil {
		return err
	}
	for _, task := range pending {
		if task.BindingEpoch != c.installation().BindingEpoch {
			return state.ErrConflict
		}
		if err = c.reportResult(ctx, task); err != nil {
			return err
		}
	}
	return nil
}
