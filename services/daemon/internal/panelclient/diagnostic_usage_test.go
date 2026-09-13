package panelclient

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1/bifurcationv1connect"
	"github.com/Zxilly/bifurcation/services/daemon/internal/core"
	"github.com/Zxilly/bifurcation/services/daemon/internal/identity"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
)

func TestDiagnosticBudgetAccountsForJSONEscapes(t *testing.T) {
	diagnostic := map[string]any{"hostname": "fixture", "logs": core.LogResult{Source: "embedded-core", Lines: []string{strings.Repeat("\"\\\n<>", 1000), "newest useful message"}}}
	body, err := encodeDiagnostic(diagnostic, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) > 1024 {
		t.Fatal("JSON payload exceeded requested budget")
	}
	var decoded struct {
		Logs core.LogResult `json:"logs"`
	}
	if err = json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.Logs.Truncated || len(decoded.Logs.Lines) != 1 || decoded.Logs.Lines[0] != "newest useful message" {
		t.Fatalf("did not preserve newest complete logs: %+v", decoded.Logs)
	}
	if _, err = encodeDiagnostic(map[string]any{"metadata": strings.Repeat("x", 2000)}, 64); err == nil {
		t.Fatal("oversized metadata was silently accepted")
	}
}

type usageACKPanel struct {
	bifurcationv1connect.UnimplementedMachineServiceHandler
	calls int
}

func (p *usageACKPanel) ReportUsage(_ context.Context, request *connect.Request[v1.ReportUsageRequest]) (*connect.Response[v1.ReportUsageResponse], error) {
	p.calls++
	return connect.NewResponse(&v1.ReportUsageResponse{CommittedSequence: request.Msg.Sequence, ExpectedSequence: request.Msg.Sequence + 1}), nil
}
func TestPersistedUsageBacklogIsVisibleAfterRestartAndClearsOnDrain(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	path := filepath.Join(directory, "state.db")
	store, err := state.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	installation := identity.Identity{InstallationID: strings.Repeat("a", 48), BindingEpoch: 1}
	stream := "usage-" + installation.InstallationID
	now := time.Now().UnixMilli()
	for i := 0; i <= 130; i++ {
		if _, err = store.RecordSample(ctx, stream, []state.Counter{{UserID: "user", RuntimeID: "core", Upload: int64(i), ObservedAt: now - 120_000 + int64(i)}}); err != nil {
			t.Fatal(err)
		}
	}
	store.Close()
	store, err = state.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	panel := &usageACKPanel{}
	route, handler := bifurcationv1connect.NewMachineServiceHandler(panel)
	mux := http.NewServeMux()
	mux.Handle("/rpc"+route, http.StripPrefix("/rpc", handler))
	server := httptest.NewServer(mux)
	defer server.Close()
	client := New(identity.Config{PanelURL: server.URL, Token: "fixture", StateDirectory: directory}, installation, store, "test", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if client.persistentUsageIssue(ctx) == "" {
		t.Fatal("restarted daemon concealed its persisted backlog")
	}
	if err = client.flushUsage(ctx); err != nil {
		t.Fatal(err)
	}
	queue, err := store.UsageQueue(ctx, stream)
	if err != nil || queue.PendingBatches != 2 || client.reportIssue == "" {
		t.Fatalf("bounded drain hid remaining backlog: %+v %q %v", queue, client.reportIssue, err)
	}
	if err = client.flushUsage(ctx); err != nil {
		t.Fatal(err)
	}
	if client.persistentUsageIssue(ctx) != "" || client.reportIssue != "" {
		t.Fatal("drained backlog remained incomplete")
	}
	// Normal 5-second collection / 10-second reporting should not remain incomplete.
	for i := 1; i <= 2; i++ {
		if _, err = store.RecordSample(ctx, stream, []state.Counter{{UserID: "user", RuntimeID: "core", Upload: 130 + int64(i), ObservedAt: now - 5000 + int64(i)*2000}}); err != nil {
			t.Fatal(err)
		}
	}
	if client.persistentUsageIssue(ctx) != "" {
		t.Fatal("ordinary fresh batches were treated as persistent backlog")
	}
}
