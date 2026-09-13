package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/internal/identity"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	"github.com/Zxilly/bifurcation/services/daemon/internal/system"
)

func TestShutdownEvidenceRequiresSuccessfulFinalSampleFromSameProcess(t *testing.T) {
	directory := t.TempDir()
	c := &Controller{config: identity.Config{StateDirectory: directory}}
	ready := Ready{PID: 123, Version: "0.2.0", SHA256: strings.Repeat("a", 64), StartTicks: "123456", ReadyAt: 1000}
	write := func(record ExitRecord) {
		t.Helper()
		data, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		if err = system.AtomicWrite(filepath.Join(directory, "updater", "exit.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.confirmStopped(ready); err == nil {
		t.Fatal("missing final-sample evidence allowed cleanup")
	}
	write(ExitRecord{Ready: ready, Kind: "clean_shutdown"})
	if err := c.confirmStopped(ready); err != nil {
		t.Fatal(err)
	}
	write(ExitRecord{Ready: ready, Kind: "shutdown_failed"})
	if err := c.confirmStopped(ready); err == nil {
		t.Fatal("failed final sample allowed cleanup")
	}
	// A PID can be reused. A clean exit with the same version and digest is not
	// sufficient when it belongs to an earlier incarnation of that PID.
	previous := ready
	previous.StartTicks = "123455"
	previous.ReadyAt--
	write(ExitRecord{Ready: previous, Kind: "clean_shutdown"})
	if err := c.confirmStopped(ready); err == nil {
		t.Fatal("stale clean exit allowed cleanup of a later process")
	}
	for _, kind := range []string{"authentication_rejected", "protocol_conflict"} {
		write(ExitRecord{Ready: ready, Kind: kind})
		if err := c.confirmStopped(ready); err != nil {
			t.Fatalf("clean shutdown retaining %s classification: %v", kind, err)
		}
	}
}

func TestUninstallReadinessMatchesTheHandedOffBinary(t *testing.T) {
	directory := t.TempDir()
	c := &Controller{config: identity.Config{StateDirectory: directory}}
	ready := Ready{PID: 123, Version: "0.2.0", SHA256: strings.Repeat("a", 64), StartTicks: "123456", ReadyAt: 1000}
	data, err := json.Marshal(ready)
	if err != nil {
		t.Fatal(err)
	}
	if err = system.AtomicWrite(filepath.Join(directory, "updater", "ready.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	plan := &Plan{OldVersion: ready.Version, OldSHA256: ready.SHA256}
	if actual, err := c.shutdownReady(plan); err != nil || actual != ready {
		t.Fatalf("readiness: %+v, %v", actual, err)
	}
	plan.OldSHA256 = strings.Repeat("b", 64)
	if _, err := c.shutdownReady(plan); err == nil {
		t.Fatal("readiness of another executable matched the handoff")
	}
	if err = os.WriteFile(filepath.Join(directory, "updater", "ready.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := c.shutdownReady(plan); err == nil {
		t.Fatal("empty readiness evidence was accepted")
	}
}

func TestHelperStatusUsesApprovedStateWithoutInventingLiveEngineHealth(t *testing.T) {
	ctx := context.Background()
	store, err := state.Open(ctx, filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	c := &Controller{store: store}
	if actual := c.status(ctx, "0.2.0"); actual.CoreHealth != v1.CoreHealth_CORE_HEALTH_NOT_CONFIGURED {
		t.Fatalf("unconfigured status: %v", actual)
	}
	if err = store.PersistPolicy(ctx, 1, []byte(`{"version":1,"policyRevision":"1","users":[]}`)); err != nil {
		t.Fatal(err)
	}
	approved := []byte(`{"log":{"level":"info"}}`)
	if err = store.CommitCore(ctx, "approved", 1, approved); err != nil {
		t.Fatal(err)
	}
	if err = store.PrepareCore(ctx, "next-task", "pending", 1, []byte(`{"log":{"level":"debug"}}`)); err != nil {
		t.Fatal(err)
	}
	actual := c.status(ctx, "0.2.0")
	digest := sha256.Sum256(approved)
	if actual.DaemonVersion != "0.2.0" || actual.AppliedRevisionId != "approved" || actual.AppliedPolicyRevision != 1 || actual.AppliedConfigSha256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("helper did not preserve approved configuration: %v", actual)
	}
	if actual.CoreHealth != v1.CoreHealth_CORE_HEALTH_UNSPECIFIED || actual.CoreVersion != "" || actual.CoreRuntimeId != "" {
		t.Fatalf("helper claimed knowledge of another process's embedded engine: %v", actual)
	}
}
