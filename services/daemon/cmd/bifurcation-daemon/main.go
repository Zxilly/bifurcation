package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"github.com/Zxilly/bifurcation/services/daemon/internal/adapters/singbox"
	"github.com/Zxilly/bifurcation/services/daemon/internal/identity"
	"github.com/Zxilly/bifurcation/services/daemon/internal/panelclient"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	"github.com/Zxilly/bifurcation/services/daemon/internal/updater"
)

var version = "dev"

func main() {
	if err := run(); err != nil && !errors.Is(err, context.Canceled) {
		slog.Error("daemon stopped", "error", err)
		os.Exit(1)
	}
}
func run() (result error) {
	configPath := flag.String("config", "/etc/bifurcation/daemon.json", "configuration file")
	check := flag.Bool("check", false, "verify configuration and local persistent state, then exit")
	showVersion := flag.Bool("version", false, "print version")
	configure := flag.Bool("configure", false, "write configuration, reading one token line from stdin")
	replaceConfig := flag.Bool("replace-config", false, "explicitly allow replacing a different existing configuration")
	panelURL := flag.String("panel", "", "panel URL for configure")
	stateDirectory := flag.String("state-directory", "/var/lib/bifurcation", "persistent directory for configure")

	capabilities := flag.Bool("capabilities", false, "print maintenance compatibility information")
	updateHelper := flag.Bool("update-helper", false, "run an independently scheduled update handoff")
	recoverUpdate := flag.Bool("recover-update", false, "recover an interrupted update before the daemon starts")
	uninstallHelper := flag.Bool("uninstall-helper", false, "finish an independently scheduled uninstall")
	verifyRecovery := flag.String("verify-recovery", "", "verify a retained helper before installation changes the database")
	flag.Parse()
	if *verifyRecovery != "" {
		return updater.VerifyRecovery(*verifyRecovery)
	}
	if *capabilities {
		return json.NewEncoder(os.Stdout).Encode(updater.Describe(version))
	}
	if *showVersion {
		fmt.Println(version)
		return nil
	}
	if *configure {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 1024), 8192)
		if !scanner.Scan() {
			if err := scanner.Err(); err != nil {
				return err
			}
			return errors.New("machine token is required on stdin")
		}
		return identity.WriteConfig(*configPath, identity.Config{PanelURL: *panelURL, Token: strings.TrimSpace(scanner.Text()), StateDirectory: *stateDirectory}, *replaceConfig)
	}
	config, err := identity.LoadConfig(*configPath)
	if err != nil {
		return err
	}
	if *uninstallHelper {
		temporary := updater.New(config, *configPath, version, nil)
		done, err := temporary.CleanupAcknowledged(context.Background())
		if done || err != nil {
			return err
		}
	}
	id, err := identity.Load(config.StateDirectory)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	store, err := state.Open(ctx, filepath.Join(config.StateDirectory, "state.db"))
	if err != nil {
		return err
	}
	defer store.Close()
	maintenance := updater.New(config, *configPath, version, store)
	if *updateHelper {
		return maintenance.RunUpgrade(ctx)
	}
	if *recoverUpdate {
		return maintenance.RecoverBeforeStart(ctx)
	}
	if *uninstallHelper {
		return maintenance.RunUninstall(ctx)
	}
	if *check {
		saved, err := store.Core(ctx)
		if err != nil {
			return err
		}
		if len(saved.AppliedConfig) > 0 {
			safe, err := singbox.MergeAuthorization(saved.AppliedConfig, saved.Authorization)
			if err != nil {
				return err
			}
			if err = singbox.New(store, config.StateDirectory).Validate(ctx, safe, saved.Authorization); err != nil {
				return fmt.Errorf("embedded configuration is incompatible: %w", err)
			}
		}
		fmt.Println("daemon configuration, state and embedded configuration verified")
		return nil
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	adapter := singbox.New(store, config.StateDirectory)
	client := panelclient.New(config, id, store, version, logger)
	client.SetCore(adapter)
	client.SetMaintenance(maintenance)
	ready := false
	defer func() {
		closeCtx, stopClose := context.WithTimeout(context.Background(), 15*time.Second)
		closeErr := adapter.Close(closeCtx)
		stopClose()
		if closeErr != nil {
			if ready {
				_ = updater.MarkExit(config.StateDirectory, version, "shutdown_failed")
			}
			result = fmt.Errorf("cannot settle embedded core shutdown: %w", closeErr)
			return
		}
		if !ready {
			return
		}
		kind := "clean_shutdown"
		if connect.CodeOf(result) == connect.CodeUnauthenticated || connect.CodeOf(result) == connect.CodePermissionDenied {
			kind = "authentication_rejected"
		} else if errors.Is(result, state.ErrConflict) {
			kind = "protocol_conflict"
		}
		if err := updater.MarkExit(config.StateDirectory, version, kind); err != nil {
			result = fmt.Errorf("cannot persist settled shutdown: %w", err)
		}
	}()
	if err = adapter.Recover(ctx); err != nil {
		return fmt.Errorf("embedded core recovery failed: %w", err)
	}
	if err = updater.MarkReady(config.StateDirectory, version); err != nil {
		return err
	}
	ready = true
	if err = maintenance.ConfirmRecoveryReady(ctx); err != nil {
		return err
	}
	return client.Run(ctx)
}
