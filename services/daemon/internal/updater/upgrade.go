package updater

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/Zxilly/bifurcation/services/daemon/internal/system"
)

func (c *Controller) RunUpgrade(ctx context.Context) error {
	plan, err := c.load("upgrade")
	if err != nil {
		return err
	}
	if plan == nil {
		return errors.New("upgrade handoff is missing")
	}
	if plan.Phase == "completed" {
		return nil
	}
	task, err := c.store.Task(ctx, plan.TaskID)
	if err != nil {
		return err
	}
	if task.Hash != plan.PayloadHash {
		return errors.New("upgrade task identity differs from handoff")
	}
	if task.Status == "succeeded" || task.Status == "failed" {
		return c.finish(ctx, plan, "completed", task.Status == "succeeded", "", "", plan.NewVersion)
	}
	if plan.Phase == "local_healthy" || plan.Phase == "result_pending_ack" {
		return c.finish(ctx, plan, "completed", true, "", plan.LocalIssue, plan.NewVersion)
	}
	if plan.Phase != "updater_ready" {
		return c.rollbackUpgrade(ctx, plan, errors.New("independent updater was interrupted before local health confirmation"))
	}
	candidateHash, err := system.FileSHA256(plan.Candidate)
	if err != nil || candidateHash != plan.NewSHA256 {
		return c.failBeforeSwitch(ctx, plan, "verified candidate is missing or changed")
	}
	oldHash, err := system.FileSHA256(plan.Backup)
	if err != nil || oldHash != plan.OldSHA256 {
		return c.failBeforeSwitch(ctx, plan, "previous daemon backup is missing or changed")
	}
	ready, err := c.shutdownReady(plan)
	if err != nil {
		return c.failBeforeSwitch(ctx, plan, err.Error())
	}
	if err = checkServicePID(ctx, ready, false); err != nil {
		return c.failBeforeSwitch(ctx, plan, err.Error())
	}
	plan.Phase = "switching"
	if err = c.save(plan); err != nil {
		return err
	}
	_, _ = c.publish(ctx, plan.TaskID, "switching", false, false, "", "", plan.OldVersion)
	stopCtx, stopCancel := context.WithTimeout(ctx, 30*time.Second)
	_, err = system.Command(stopCtx, "systemctl", "stop", DaemonUnit)
	stopCancel()
	if err != nil {
		return c.rollbackUpgrade(ctx, plan, err)
	}
	if err = checkServicePID(ctx, ready, true); err != nil {
		return c.rollbackUpgrade(ctx, plan, err)
	}
	if err = c.confirmStopped(ready); err != nil {
		return c.rollbackUpgrade(ctx, plan, err)
	}
	if err = os.Rename(plan.Candidate, InstalledBinary); err != nil {
		return c.rollbackUpgrade(ctx, plan, err)
	}
	system.SyncDirectory(filepath.Dir(InstalledBinary))
	plan.Phase = "starting"
	plan.StartAfter = time.Now().UnixMilli()
	if err = c.save(plan); err != nil {
		return c.rollbackUpgrade(ctx, plan, err)
	}
	_, _ = c.publish(ctx, plan.TaskID, "starting", false, false, "", "", plan.OldVersion)
	startCtx, startCancel := context.WithTimeout(ctx, 30*time.Second)
	_, err = system.Command(startCtx, "systemctl", "start", DaemonUnit)
	startCancel()
	if err != nil {
		return c.rollbackUpgrade(ctx, plan, err)
	}
	plan.LocalIssue, err = c.waitLocal(ctx, plan.NewVersion, plan.NewSHA256, plan.StartAfter)
	if err != nil {
		return c.rollbackUpgrade(ctx, plan, err)
	}
	plan.Phase = "local_healthy"
	if err = c.save(plan); err != nil {
		return err
	}
	_, _ = c.publish(ctx, plan.TaskID, "local_healthy", false, false, "", plan.LocalIssue, plan.NewVersion)
	return c.finish(ctx, plan, "completed", true, "", plan.LocalIssue, plan.NewVersion)
}
func (c *Controller) failBeforeSwitch(ctx context.Context, plan *Plan, message string) error {
	return c.finish(ctx, plan, "failed", false, "UPDATE_PREFLIGHT_FAILED", message, plan.OldVersion)
}
func (c *Controller) rollbackUpgrade(ctx context.Context, plan *Plan, cause error) error {
	recovery, cancel := context.WithTimeout(context.WithoutCancel(ctx), 90*time.Second)
	defer cancel()
	plan.Phase = "rolling_back"
	if err := c.save(plan); err != nil {
		return err
	}
	_, _ = c.publish(recovery, plan.TaskID, "rolling_back", false, false, "", cause.Error(), plan.OldVersion)
	_, _ = system.Command(recovery, "systemctl", "stop", DaemonUnit)
	rollbackStart := time.Now().UnixMilli()
	digest, err := system.FileSHA256(plan.Backup)
	if err == nil && digest != plan.OldSHA256 {
		err = errors.New("previous binary checksum changed")
	}
	if err == nil {
		err = system.CopyAtomic(plan.Backup, InstalledBinary, 0755)
	}
	if err == nil {
		_, err = system.Command(recovery, "systemctl", "start", DaemonUnit)
	}
	if err == nil {
		_, err = c.waitLocal(recovery, plan.OldVersion, plan.OldSHA256, rollbackStart)
	}
	if err != nil {
		return c.finish(ctx, plan, "failed", false, "ROLLBACK_FAILED", fmt.Sprintf("upgrade failed (%v); rollback failed: %v", cause, err), plan.OldVersion)
	}
	return c.finish(ctx, plan, "rolled_back", false, "UPDATE_FAILED", cause.Error(), plan.OldVersion)
}

// RecoverBeforeStart is executed by a separately retained known-good binary.
// It never waits for the panel and never restores an old copy of the database.
func (c *Controller) RecoverBeforeStart(ctx context.Context) error {
	plan, err := c.load("upgrade")
	if err != nil {
		return err
	}
	if plan == nil || plan.Phase == "completed" {
		return nil
	}
	if helperActive(ctx, plan.HelperUnit) {
		return nil
	}
	task, err := c.store.Task(ctx, plan.TaskID)
	if err != nil {
		return err
	}
	if task.Status == "succeeded" || task.Status == "failed" {
		return nil
	}
	if plan.Phase == "local_healthy" || plan.Phase == "result_pending_ack" {
		_, err = c.persist(ctx, plan.TaskID, "completed", true, true, "", "", plan.NewVersion)
		return err
	}
	backupHash, err := system.FileSHA256(plan.Backup)
	if err != nil {
		return err
	}
	if backupHash != plan.OldSHA256 {
		return errors.New("recovery backup checksum changed")
	}
	if err = system.CopyAtomic(plan.Backup, InstalledBinary, 0755); err != nil {
		return err
	}
	_, err = c.persist(ctx, plan.TaskID, "rolling_back", false, false, "", "An unconfirmed switch was restored; awaiting local startup confirmation", plan.OldVersion)
	if err != nil {
		return err
	}
	plan.Phase = "restored_pending_health"
	return c.save(plan)
}

func (c *Controller) ConfirmRecoveryReady(ctx context.Context) error {
	plan, err := c.load("upgrade")
	if err != nil {
		return err
	}
	if plan == nil || plan.Phase != "restored_pending_health" {
		return nil
	}
	digest, err := system.FileSHA256("/proc/self/exe")
	if err != nil {
		return err
	}
	if digest != plan.OldSHA256 || c.version != plan.OldVersion {
		return errors.New("recovery did not start the verified previous daemon")
	}
	if _, err = c.persist(ctx, plan.TaskID, "rolled_back", true, false, "UPDATE_INTERRUPTED", "The retained helper restored the previous daemon and local startup was confirmed", plan.OldVersion); err != nil {
		return err
	}
	plan.Phase = "result_pending_ack"
	return c.save(plan)
}
