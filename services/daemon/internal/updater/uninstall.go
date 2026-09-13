package updater

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	"github.com/Zxilly/bifurcation/services/daemon/internal/system"
)

func (c *Controller) BeginUninstall(ctx context.Context, task state.Task) error {
	if err := c.validateInstallation(); err != nil {
		return err
	}
	if err := c.ensureIdle(ctx); err != nil {
		return err
	}
	if !safeTaskID.MatchString(task.ID) {
		return errors.New("invalid maintenance task ID")
	}
	directory := c.taskDirectory(task.ID)
	digest, err := system.FileSHA256(InstalledBinary)
	if err != nil {
		return err
	}
	plan := &Plan{Format: 1, Kind: "uninstall", TaskID: task.ID, PayloadHash: task.Hash, Phase: "updater_ready", HelperUnit: UninstallUnit, ConfigPath: c.configPath, Helper: filepath.Join(directory, "helper"), OldVersion: c.version, OldSHA256: digest}
	if err = system.CopyAtomic(InstalledBinary, plan.Helper, 0755); err != nil {
		return err
	}
	if err = c.save(plan); err != nil {
		return err
	}
	var unit strings.Builder
	unit.WriteString(fmt.Sprintf("# Managed by Bifurcation maintenance\n[Unit]\nDescription=Finish Bifurcation uninstall\nAfter=network-online.target\nWants=network-online.target\nConditionPathExists=%s\n\n[Service]\nType=simple\nExecStart=%s -uninstall-helper -config %s\nRestart=on-failure\nRestartSec=10\nUMask=0077\n", c.planPath("uninstall"), quoteUnit(plan.Helper), quoteUnit(c.configPath)))
	for _, key := range []string{"SSL_CERT_FILE", "SSL_CERT_DIR"} {
		if value := os.Getenv(key); value != "" {
			unit.WriteString("Environment=" + quoteUnit(key+"="+value) + "\n")
		}
	}
	unit.WriteString("\n[Install]\nWantedBy=multi-user.target\n")
	if err = system.AtomicWrite(filepath.Join(unitDirectory, UninstallUnit), []byte(unit.String()), 0644); err != nil {
		return err
	}
	for _, args := range [][]string{{"daemon-reload"}, {"enable", UninstallUnit}, {"start", UninstallUnit}} {
		if _, err = system.Command(ctx, "systemctl", args...); err != nil {
			plan.Phase = "completed"
			_ = c.save(plan)
			return err
		}
	}
	return ErrHandedOff
}
func (c *Controller) drainUsage(ctx context.Context) error {
	installation, err := c.installation()
	if err != nil {
		return err
	}
	streamID := "usage-" + installation.InstallationId
	issue, err := c.store.UsageRecoveryIssue(ctx, streamID)
	if err != nil {
		return err
	}
	if issue != "" {
		return fmt.Errorf("usage recovery is required before local data can be removed: %s", issue)
	}
	delay := time.Second
	for {
		batch, err := c.store.NextBatch(ctx, streamID)
		if err != nil {
			return err
		}
		if batch == nil {
			return nil
		}
		request := connect.NewRequest(&v1.ReportUsageRequest{Installation: installation, StreamId: streamID, Sequence: batch.Seq, Payload: batch.Payload, PayloadSha256: batch.Hash})
		request.Header().Set("Authorization", "Bearer "+c.config.Token)
		callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		response, err := c.rpc.ReportUsage(callCtx, request)
		cancel()
		if err == nil {
			if response.Msg.CommittedSequence < batch.Seq {
				issue := fmt.Sprintf("panel expects usage sequence %d but earliest retained sequence is %d", response.Msg.ExpectedSequence, batch.Seq)
				_ = c.store.RequireUsageRecovery(ctx, streamID, issue)
				return errors.New(issue)
			}
			if err = c.store.AcknowledgeUsage(ctx, streamID, response.Msg.CommittedSequence); err != nil {
				return err
			}
			delay = time.Second
			continue
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		slog.Warn("uninstall is retaining unacknowledged usage", "error", err)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		delay = min(delay*2, 30*time.Second)
	}
}
func (c *Controller) RunUninstall(ctx context.Context) error {
	plan, err := c.load("uninstall")
	if err != nil {
		return err
	}
	if plan == nil {
		return errors.New("uninstall handoff is missing")
	}
	if plan.Phase == "failed" || plan.Phase == "completed" {
		return nil
	}
	if plan.Phase == "acknowledged" {
		return c.cleanupUninstall(ctx, plan)
	}
	task, err := c.store.Task(ctx, plan.TaskID)
	if err != nil {
		return err
	}
	if task.Hash != plan.PayloadHash {
		return errors.New("uninstall task identity differs from handoff")
	}
	if task.Status == "failed" {
		plan.Phase = "failed"
		_ = c.save(plan)
		_, _ = c.send(ctx, task)
		return nil
	}
	if task.Status != "succeeded" {
		// Repeat shutdown verification even after a crash in removing_services:
		// the still-enabled daemon may have restarted during the intervening boot.
		ready, err := c.shutdownReady(plan)
		if err != nil {
			return c.uninstallFailed(ctx, plan, err)
		}
		plan.Phase = "stopping_daemon"
		if err = c.save(plan); err != nil {
			return err
		}
		_, _ = c.publish(ctx, plan.TaskID, "stopping_daemon", false, false, "", "", plan.OldVersion)
		if _, exists := os.Stat(filepath.Join(unitDirectory, DaemonUnit)); exists == nil || helperActive(ctx, DaemonUnit) {
			if err = checkServicePID(ctx, ready, false); err != nil {
				return c.uninstallFailed(ctx, plan, err)
			}
			stopCtx, stop := context.WithTimeout(ctx, 30*time.Second)
			_, err = system.Command(stopCtx, "systemctl", "stop", DaemonUnit)
			stop()
			if err != nil {
				return c.uninstallFailed(ctx, plan, err)
			}
			if err = checkServicePID(ctx, ready, true); err != nil {
				return c.uninstallFailed(ctx, plan, err)
			}
		} else if !errors.Is(exists, os.ErrNotExist) {
			return c.uninstallFailed(ctx, plan, exists)
		}
		if err = c.confirmStopped(ready); err != nil {
			return c.uninstallFailed(ctx, plan, err)
		}
		// Final embedded counters were persisted by the daemon's Close callback.
		// A separate helper cannot sample an engine that lived in that process.
		plan.Phase = "draining_usage"
		if err = c.save(plan); err != nil {
			return err
		}
		_, _ = c.publish(ctx, plan.TaskID, "draining_usage", false, false, "", "", plan.OldVersion)
		if err = c.drainUsage(ctx); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return c.uninstallFailed(ctx, plan, err)
		}
		plan.Phase = "removing_services"
		if err = c.save(plan); err != nil {
			return err
		}
		_, _ = c.publish(ctx, plan.TaskID, "removing_services", false, false, "", "", plan.OldVersion)
		if _, exists := os.Stat(filepath.Join(unitDirectory, DaemonUnit)); exists == nil {
			if _, err = system.Command(ctx, "systemctl", "disable", DaemonUnit); err != nil {
				return c.uninstallFailed(ctx, plan, err)
			}
		}
		if err = removeFile(filepath.Join(unitDirectory, DaemonUnit)); err != nil {
			return c.uninstallFailed(ctx, plan, err)
		}
		if digest, e := system.FileSHA256(InstalledBinary); e == nil {
			if digest != plan.OldSHA256 {
				return c.uninstallFailed(ctx, plan, errors.New("installed binary changed during uninstall"))
			}
			if err = removeFile(InstalledBinary); err != nil {
				return c.uninstallFailed(ctx, plan, err)
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			return c.uninstallFailed(ctx, plan, e)
		}
		if _, err = system.Command(ctx, "systemctl", "daemon-reload"); err != nil {
			return c.uninstallFailed(ctx, plan, err)
		}
		message := plan.LocalIssue
		if err = c.finish(ctx, plan, "uninstalled", true, "", message, ""); err != nil {
			return err
		}
	} else {
		if err = c.finish(ctx, plan, "uninstalled", true, "", "", ""); err != nil {
			return err
		}
	}
	plan.Phase = "acknowledged"
	if err = c.save(plan); err != nil {
		return err
	}
	return c.cleanupUninstall(ctx, plan)
}
func (c *Controller) uninstallFailed(ctx context.Context, plan *Plan, cause error) error {
	if err := c.finish(ctx, plan, "failed", false, "UNINSTALL_INCOMPLETE", cause.Error(), plan.OldVersion); err != nil {
		return err
	}
	plan.Phase = "failed"
	return c.save(plan)
}
func removeFile(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
func removeOwnedDirectory(path, root string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	base, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(base, absolute)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("refusing directory cleanup outside the installation")
	}
	if info, err := os.Lstat(absolute); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("refusing symbolic maintenance directory")
	}
	return os.RemoveAll(absolute)
}
func (c *Controller) cleanupUninstall(ctx context.Context, plan *Plan) error {
	if plan.Phase != "acknowledged" {
		return errors.New("cannot remove identity before final acknowledgement")
	}
	// Stop boot retries before destroying their configuration; only our helper unit is touched.
	_, _ = system.Command(ctx, "systemctl", "disable", UninstallUnit)
	if err := removeFile(filepath.Join(unitDirectory, UninstallUnit)); err != nil {
		return err
	}
	_, _ = system.Command(ctx, "systemctl", "daemon-reload")
	if c.store != nil {
		if err := c.store.Close(); err != nil {
			return err
		}
	}
	for _, name := range []string{"state.db-wal", "state.db-shm", "state.db", "identity.json"} {
		if err := removeFile(filepath.Join(c.config.StateDirectory, name)); err != nil {
			return err
		}
	}
	if err := removeFile(c.configPath); err != nil {
		return err
	}
	_ = os.Remove(filepath.Dir(c.configPath))
	if err := removeFile(RecoveryBinary); err != nil {
		return err
	}
	if err := removeOwnedDirectory(filepath.Join(c.config.StateDirectory, "core"), c.config.StateDirectory); err != nil {
		return err
	}
	if err := removeOwnedDirectory(filepath.Join(c.config.StateDirectory, "updater"), c.config.StateDirectory); err != nil {
		return err
	}
	// Remove only an empty root; unrelated files are preserved.
	_ = os.Remove(c.config.StateDirectory)
	return nil
}
func (c *Controller) CleanupAcknowledged(ctx context.Context) (bool, error) {
	plan, err := c.load("uninstall")
	if err != nil {
		return false, err
	}
	if plan == nil || plan.Phase != "acknowledged" {
		return false, nil
	}
	return true, c.cleanupUninstall(ctx, plan)
}
