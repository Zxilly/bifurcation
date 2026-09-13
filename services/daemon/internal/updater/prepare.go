package updater

import (
	"context"
	"debug/elf"
	"encoding/json"
	"errors"

	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/Zxilly/bifurcation/services/daemon/internal/core"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	"github.com/Zxilly/bifurcation/services/daemon/internal/system"
)

func (c *Controller) BeginUpgrade(ctx context.Context, task state.Task, artifact core.Artifact) error {
	if err := c.validateInstallation(); err != nil {
		return err
	}
	if err := c.ensureIdle(ctx); err != nil {
		return err
	}
	if !safeTaskID.MatchString(task.ID) {
		return errors.New("invalid maintenance task ID")
	}
	if artifact.OS != runtime.GOOS || artifact.Arch != runtime.GOARCH || artifact.Version == "" || len(artifact.Version) > 128 {
		return errors.New("daemon artifact platform or version is invalid")
	}
	_, _ = c.publish(ctx, task.ID, "downloading", false, false, "", "", c.version)
	directory := c.taskDirectory(task.ID)
	candidate, err := system.DownloadBinary(ctx, artifact, directory, c.config.PanelURL, c.config.Token)
	if err != nil {
		return err
	}
	file, err := elf.Open(candidate)
	if err != nil {
		return errors.New("candidate is not a Linux ELF executable")
	}
	machine := file.Machine
	file.Close()
	if runtime.GOARCH == "amd64" && machine != elf.EM_X86_64 || runtime.GOARCH == "arm64" && machine != elf.EM_AARCH64 {
		return errors.New("candidate ELF architecture differs from manifest")
	}
	checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	output, err := system.Command(checkCtx, candidate, "-capabilities")
	if err != nil {
		return err
	}
	var capabilities Capabilities
	if err = json.Unmarshal([]byte(output), &capabilities); err != nil {
		return errors.New("candidate does not expose valid compatibility information")
	}
	if capabilities.Version != artifact.Version || capabilities.OS != runtime.GOOS || capabilities.Arch != runtime.GOARCH || capabilities.MaintenanceProtocol != 1 || capabilities.SchemaFingerprint != state.SchemaFingerprint() {
		return errors.New("candidate version, platform or state migration contract is incompatible with automatic rollback")
	}
	if _, err = system.Command(checkCtx, candidate, "-config", c.configPath, "-check"); err != nil {
		return err
	}
	_, _ = c.publish(ctx, task.ID, "verified", false, false, "", "", c.version)
	oldDigest, err := system.FileSHA256(InstalledBinary)
	if err != nil {
		return err
	}
	runningDigest, err := system.FileSHA256("/proc/self/exe")
	if err != nil {
		return err
	}
	if oldDigest != runningDigest {
		return errors.New("installed daemon changed outside this operation")
	}
	plan := &Plan{Format: 1, Kind: "upgrade", TaskID: task.ID, PayloadHash: task.Hash, Phase: "updater_ready", HelperUnit: "bifurcation-update-" + task.ID + ".service", ConfigPath: c.configPath, Backup: filepath.Join(directory, "previous-daemon"), Candidate: filepath.Join(filepath.Dir(InstalledBinary), ".bifurcation-candidate-"+task.ID), Helper: filepath.Join(directory, "helper"), OldVersion: c.version, NewVersion: artifact.Version, OldSHA256: oldDigest, NewSHA256: strings.ToLower(artifact.SHA256)}
	if err = system.CopyAtomic(InstalledBinary, plan.Backup, 0755); err != nil {
		return err
	}
	if err = system.CopyAtomic(InstalledBinary, plan.Helper, 0755); err != nil {
		return err
	}
	if err = system.CopyAtomic(candidate, plan.Candidate, 0755); err != nil {
		return err
	}
	if err = c.ensureRecovery(ctx); err != nil {
		return err
	}
	if err = c.save(plan); err != nil {
		return err
	}
	_, _ = c.publish(ctx, task.ID, "updater_ready", false, false, "", "", c.version)
	args := []string{"--unit=" + plan.HelperUnit, "--collect", "--property=Type=simple", "--property=UMask=0077"}
	for _, key := range []string{"SSL_CERT_FILE", "SSL_CERT_DIR"} {
		if value := os.Getenv(key); value != "" {
			args = append(args, "--setenv="+key+"="+value)
		}
	}
	args = append(args, plan.Helper, "-update-helper", "-config", c.configPath)
	if _, err = system.Command(ctx, "systemd-run", args...); err != nil {
		plan.Phase = "completed"
		_ = c.save(plan)
		return err
	}
	return ErrHandedOff
}
func (c *Controller) ensureRecovery(ctx context.Context) error {
	if info, err := os.Lstat(RecoveryBinary); errors.Is(err, os.ErrNotExist) {
		if err = system.CopyAtomic(InstalledBinary, RecoveryBinary, 0755); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if !info.Mode().IsRegular() {
		return errors.New("recovery helper is not a regular file")
	}
	output, err := system.Command(ctx, RecoveryBinary, "-capabilities")
	if err != nil {
		return err
	}
	var capability Capabilities
	if err = json.Unmarshal([]byte(output), &capability); err != nil {
		return err
	}
	if capability.SchemaFingerprint != state.SchemaFingerprint() || capability.MaintenanceProtocol != 1 {
		return errors.New("installed recovery helper is incompatible; reinstall the current daemon first")
	}
	path := filepath.Join(unitDirectory, DaemonUnit)
	unit, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	line := "ExecStartPre=" + RecoveryBinary + " -recover-update -config " + quoteUnit(c.configPath)
	if !strings.Contains(string(unit), "ExecStartPre="+RecoveryBinary) {
		updated := strings.Replace(string(unit), "ExecStart="+InstalledBinary, line+"\nExecStart="+InstalledBinary, 1)
		if err = system.AtomicWrite(path, []byte(updated), 0644); err != nil {
			return err
		}
		if _, err = system.Command(ctx, "systemctl", "daemon-reload"); err != nil {
			return err
		}
	}
	return nil
}

func VerifyRecovery(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	output, err := system.Command(ctx, path, "-capabilities")
	if err != nil {
		return err
	}
	var capability Capabilities
	if err = json.Unmarshal([]byte(output), &capability); err != nil {
		return err
	}
	if capability.SchemaFingerprint != state.SchemaFingerprint() || capability.MaintenanceProtocol != 1 {
		return errors.New("recovery helper is incompatible with this daemon's migration contract")
	}
	return nil
}
