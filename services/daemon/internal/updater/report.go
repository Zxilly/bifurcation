package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/internal/identity"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	"github.com/Zxilly/bifurcation/services/daemon/internal/system"
	"google.golang.org/protobuf/proto"
)

func (c *Controller) installation() (*v1.Installation, error) {
	id, err := identity.Load(c.config.StateDirectory)
	if err != nil {
		return nil, err
	}
	return &v1.Installation{InstallationId: id.InstallationID, BindingEpoch: id.BindingEpoch}, nil
}
func (c *Controller) status(ctx context.Context, version string) *v1.MachineStatus {
	status := &v1.MachineStatus{ObservedAtUnixMs: time.Now().UnixMilli(), DaemonVersion: version, CoreHealth: v1.CoreHealth_CORE_HEALTH_UNSPECIFIED}
	saved, err := c.store.Core(ctx)
	if err != nil {
		status.Issue = err.Error()
		return status
	}
	// This helper does not own the running embedded engine. Approved state is
	// evidence of configuration, never evidence that another process is healthy.
	status.AppliedRevisionId = saved.AppliedRevision
	status.AppliedPolicyRevision = saved.AppliedPolicy
	if len(saved.AppliedConfig) == 0 {
		status.CoreHealth = v1.CoreHealth_CORE_HEALTH_NOT_CONFIGURED
	} else {
		digest := sha256.Sum256(saved.AppliedConfig)
		status.AppliedConfigSha256 = hex.EncodeToString(digest[:])
	}
	return status
}
func (c *Controller) persist(ctx context.Context, taskID, phase string, terminal, success bool, errorCode, message, actualVersion string) (state.Task, error) {
	task, err := c.store.Task(ctx, taskID)
	if err != nil {
		return task, err
	}
	if task.Status == "succeeded" || task.Status == "failed" {
		return task, nil
	}
	installation, err := c.installation()
	if err != nil {
		return task, err
	}
	if task.BindingEpoch != installation.BindingEpoch {
		return task, state.ErrConflict
	}
	report := &v1.ReportTaskRequest{Installation: installation, TaskId: task.ID, PayloadSha256: task.Hash, Sequence: task.ProgressSeq + 1, State: v1.TaskState_TASK_STATE_RUNNING, Phase: phase, ErrorCode: errorCode, Message: system.LimitString(message, 8192), Rollback: v1.RollbackState_ROLLBACK_STATE_NOT_NEEDED}
	stateName := "running"
	if terminal {
		stateName = "failed"
		report.State = v1.TaskState_TASK_STATE_FAILED
		if success {
			stateName = "succeeded"
			report.State = v1.TaskState_TASK_STATE_SUCCEEDED
		}
		report.ActualStatus = c.status(ctx, actualVersion)
		if phase == "uninstalled" {
			plan, e := c.load("uninstall")
			if e == nil && plan != nil {
				report.ActualStatus = &v1.MachineStatus{ObservedAtUnixMs: time.Now().UnixMilli(), CoreHealth: v1.CoreHealth_CORE_HEALTH_STOPPED, UsageIncomplete: plan.LocalIssue != "", Issue: system.LimitString(plan.LocalIssue, 4096)}
			}
		}
	}
	if phase == "rolled_back" {
		report.Rollback = v1.RollbackState_ROLLBACK_STATE_SUCCEEDED
	}
	if errorCode == "ROLLBACK_FAILED" {
		report.Rollback = v1.RollbackState_ROLLBACK_STATE_FAILED
	}
	encoded, err := proto.Marshal(report)
	if err != nil {
		return task, err
	}
	return c.store.Transition(ctx, task.ID, stateName, encoded)
}
func (c *Controller) send(ctx context.Context, task state.Task) (bool, error) {
	report := new(v1.ReportTaskRequest)
	if err := proto.Unmarshal(task.Result, report); err != nil {
		return false, err
	}
	installation, err := c.installation()
	if err != nil {
		return false, err
	}
	report.Installation = installation
	request := connect.NewRequest(report)
	request.Header().Set("Authorization", "Bearer "+c.config.Token)
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	response, err := c.rpc.ReportTask(callCtx, request)
	if err != nil {
		return false, err
	}
	terminal := task.Status == "succeeded" || task.Status == "failed"
	if response.Msg.CommittedSequence < task.ProgressSeq || terminal && !response.Msg.Terminal {
		return false, errors.New("panel did not acknowledge maintenance result")
	}
	if terminal {
		if response.Msg.CommittedSequence != task.ProgressSeq {
			return false, state.ErrConflict
		}
		if err = c.store.AcknowledgeTask(ctx, task.ID, task.ProgressSeq); err != nil {
			return false, err
		}
	}
	return true, nil
}
func (c *Controller) publish(ctx context.Context, taskID, phase string, terminal, success bool, errorCode, message, actualVersion string) (bool, error) {
	task, err := c.persist(ctx, taskID, phase, terminal, success, errorCode, message, actualVersion)
	if err != nil {
		return false, err
	}
	return c.send(ctx, task)
}
func (c *Controller) finish(ctx context.Context, plan *Plan, phase string, success bool, errorCode, message, actualVersion string) error {
	task, err := c.persist(ctx, plan.TaskID, phase, true, success, errorCode, message, actualVersion)
	if err != nil {
		return err
	}
	plan.Phase = "result_pending_ack"
	if err = c.save(plan); err != nil {
		return err
	}
	delay := time.Second
	for {
		if task.Acknowledged {
			break
		}
		ack, err := c.send(ctx, task)
		if err == nil && ack {
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		slog.Warn("maintenance result is awaiting panel acknowledgement", "task", task.ID, "error", err)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		delay = min(delay*2, 30*time.Second)
		task, err = c.store.Task(ctx, task.ID)
		if err != nil {
			return err
		}
	}
	if plan.Kind == "upgrade" {
		plan.Phase = "completed"
		return c.save(plan)
	}
	return nil
}
