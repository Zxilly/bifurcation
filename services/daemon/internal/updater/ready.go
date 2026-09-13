package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/Zxilly/bifurcation/services/daemon/internal/system"
)

type Ready struct {
	PID        int    `json:"pid"`
	Version    string `json:"version"`
	SHA256     string `json:"sha256"`
	StartTicks string `json:"startTicks"`
	ReadyAt    int64  `json:"readyAt"`
}

func startTicks(pid int) (string, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	end := strings.LastIndex(string(data), ")")
	if end < 0 {
		return "", errors.New("invalid process identity")
	}
	fields := strings.Fields(string(data)[end+1:])
	if len(fields) < 20 || fields[0] == "Z" {
		return "", errors.New("process is not running")
	}
	return fields[19], nil
}
func MarkReady(directory, version string) error {
	if runtime.GOOS != "linux" {
		return nil
	}
	digest, err := system.FileSHA256("/proc/self/exe")
	if err != nil {
		return err
	}
	ticks, err := startTicks(os.Getpid())
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(Ready{PID: os.Getpid(), Version: version, SHA256: digest, StartTicks: ticks, ReadyAt: time.Now().UnixMilli()})
	if err != nil {
		return err
	}
	return system.AtomicWrite(filepath.Join(directory, "updater", "ready.json"), encoded, 0600)
}
func (c *Controller) waitLocal(ctx context.Context, version, digest string, notBefore int64) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	var stableSince time.Time
	lastPID := 0
	for {
		if data, e := os.ReadFile(filepath.Join(c.config.StateDirectory, "updater", "exit.json")); e == nil {
			var exit ExitRecord
			if json.Unmarshal(data, &exit) == nil && exit.Version == version && exit.SHA256 == digest && exit.ReadyAt >= notBefore && exit.ReadyAt > 0 && (exit.Kind == "authentication_rejected" || exit.Kind == "protocol_conflict") {
				return "New daemon passed local startup; control-plane credentials or binding require attention", nil
			}
		}
		output, err := system.Command(ctx, "systemctl", "show", DaemonUnit, "--property=MainPID", "--value")
		pid, parseErr := strconv.Atoi(strings.TrimSpace(output))
		readyData, readErr := os.ReadFile(filepath.Join(c.config.StateDirectory, "updater", "ready.json"))
		var ready Ready
		jsonErr := json.Unmarshal(readyData, &ready)
		ticks, tickErr := startTicks(pid)
		healthy := err == nil && parseErr == nil && readErr == nil && jsonErr == nil && tickErr == nil && pid > 0 && ready.PID == pid && ready.Version == version && ready.SHA256 == digest && ready.StartTicks == ticks && ready.ReadyAt >= notBefore
		if healthy {
			if lastPID != pid || stableSince.IsZero() {
				lastPID = pid
				stableSince = time.Now()
			}
			if time.Since(stableSince) >= 2*time.Second {
				return "", nil
			}
		} else {
			stableSince = time.Time{}
			lastPID = 0
		}
		timer := time.NewTimer(200 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", errors.New("candidate daemon did not become locally healthy")
		case <-timer.C:
		}
	}
}

type ExitRecord struct {
	Ready
	Kind string `json:"kind"`
}

// A control-plane rejection after local readiness is not a defective binary.
func MarkExit(directory, version, kind string) error {
	data, err := os.ReadFile(filepath.Join(directory, "updater", "ready.json"))
	if err != nil {
		return err
	}
	var ready Ready
	if err = json.Unmarshal(data, &ready); err != nil {
		return err
	}
	if ready.PID != os.Getpid() || ready.Version != version {
		return errors.New("exit classification has no matching local readiness evidence")
	}
	body, err := json.Marshal(ExitRecord{Ready: ready, Kind: kind})
	if err != nil {
		return err
	}
	return system.AtomicWrite(filepath.Join(directory, "updater", "exit.json"), body, 0600)
}

func (c *Controller) shutdownReady(plan *Plan) (Ready, error) {
	var ready Ready
	data, err := os.ReadFile(filepath.Join(c.config.StateDirectory, "updater", "ready.json"))
	if err != nil {
		return ready, fmt.Errorf("cannot verify daemon shutdown identity: %w", err)
	}
	if err = json.Unmarshal(data, &ready); err != nil {
		return ready, err
	}
	if ready.PID <= 0 || ready.StartTicks == "" || ready.ReadyAt <= 0 || ready.Version != plan.OldVersion || ready.SHA256 != plan.OldSHA256 {
		return ready, errors.New("daemon readiness does not match the maintenance handoff")
	}
	return ready, nil
}

func (c *Controller) confirmStopped(expected Ready) error {
	data, err := os.ReadFile(filepath.Join(c.config.StateDirectory, "updater", "exit.json"))
	if err != nil {
		return fmt.Errorf("daemon did not confirm final embedded traffic persistence: %w", err)
	}
	var exit ExitRecord
	if err = json.Unmarshal(data, &exit); err != nil {
		return err
	}
	if exit.Ready != expected {
		return errors.New("daemon exit evidence belongs to a different process")
	}
	// main preserves these control-plane classifications only after successful
	// engine closure and final sampling, so none imply an accounting failure.
	switch exit.Kind {
	case "clean_shutdown", "authentication_rejected", "protocol_conflict":
		return nil
	default:
		return errors.New("daemon shutdown did not confirm final embedded traffic persistence")
	}
}

func checkServicePID(ctx context.Context, ready Ready, stopped bool) error {
	property := "MainPID"
	if stopped {
		property = "ExecMainPID"
	}
	output, err := system.Command(ctx, "systemctl", "show", DaemonUnit, "--property="+property, "--value")
	if err != nil {
		return err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(output))
	if err != nil || pid < 0 {
		return errors.New("invalid daemon service process identity")
	}
	if pid > 0 && pid != ready.PID {
		return errors.New("daemon process changed during maintenance")
	}
	if !stopped && pid > 0 {
		ticks, err := startTicks(pid)
		if err != nil || ticks != ready.StartTicks {
			return errors.New("daemon readiness has stale process start evidence")
		}
	}
	return nil
}
