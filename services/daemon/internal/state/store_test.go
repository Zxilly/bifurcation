package state

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"math"
	"path/filepath"
	"strings"
	"testing"

	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state/ent"
	"google.golang.org/protobuf/proto"
)

func openTest(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func TestUsageAtomicRollbackReopenAndAcknowledgement(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.db")
	s := openTest(t, path)
	baseline := []Counter{{"u1", "r1", math.MaxInt64 - 100, 0, 1000, 0, false}, {"u2", "r1", 0, 0, 1000, 0, false}}
	if _, err := s.RecordSample(ctx, "stream", baseline); err != nil {
		t.Fatal(err)
	}
	// The first user updates before the second user's invalid sample aborts the transaction.
	invalid := []Counter{{"u1", "r1", math.MaxInt64 - 50, 7, 2000, 0, false}, {"u2", "r1", -1, 0, 2000, 0, false}}
	if _, err := s.RecordSample(ctx, "stream", invalid); !errors.Is(err, ErrCounterRegression) {
		t.Fatalf("got %v", err)
	}
	if batch, err := s.NextBatch(ctx, "stream"); err != nil || batch != nil {
		t.Fatalf("partial outbox: %v %v", batch, err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s = openTest(t, path)
	defer s.Close()
	batch, err := s.RecordSample(ctx, "stream", []Counter{{"u1", "r1", math.MaxInt64, 10, 3000, 0, false}})
	if err != nil {
		t.Fatal(err)
	}
	var decoded v1.UsageBatch
	if err = proto.Unmarshal(batch.Payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if batch.Seq != 1 || decoded.Deltas[0].UploadBytes != 100 || decoded.Deltas[0].DownloadBytes != 10 || decoded.Deltas[0].StartUnixMs != 1000 {
		t.Fatalf("cursor was not rolled back: %+v", &decoded)
	}
	if err = s.AcknowledgeUsage(ctx, "stream", 2); !errors.Is(err, ErrSequence) {
		t.Fatal(err)
	}
	if next, err := s.NextBatch(ctx, "stream"); err != nil || next.Hash != batch.Hash {
		t.Fatal("invalid ACK deleted batch")
	}
	if err = s.AcknowledgeUsage(ctx, "stream", 1); err != nil {
		t.Fatal(err)
	}
	if err = s.AcknowledgeUsage(ctx, "stream", 0); !errors.Is(err, ErrSequence) {
		t.Fatal("backup regression not detected")
	}
	if next, err := s.NextBatch(ctx, "stream"); err != nil || next != nil {
		t.Fatal("ACK did not remove outbox")
	}
	// Runtime changes establish a baseline and mark the unknown interval.
	b, err := s.RecordSample(ctx, "stream", []Counter{{"u1", "r2", 3, 4, 4000, 0, false}})
	if err != nil || b == nil {
		t.Fatalf("runtime gap %v %v", b, err)
	}
	var gap v1.UsageBatch
	if err = proto.Unmarshal(b.Payload, &gap); err != nil {
		t.Fatal(err)
	}
	if len(gap.Deltas) != 1 || !gap.Deltas[0].Incomplete || gap.Deltas[0].UploadBytes != 0 || gap.Deltas[0].DownloadBytes != 0 {
		t.Fatal("runtime gap misreported", &gap)
	}
}
func TestTaskJournalRetainsTerminalAcrossReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.db")
	s := openTest(t, path)
	input := Task{ID: "task", Hash: "hash", Kind: "inspect", Payload: []byte{1}, BindingEpoch: 1}
	if _, err := s.Accept(ctx, input); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Transition(ctx, input.ID, "running", nil); err != nil {
		t.Fatal(err)
	}
	terminal, err := s.Transition(ctx, input.ID, "succeeded", []byte("original"))
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	s = openTest(t, path)
	defer s.Close()
	duplicate, err := s.Accept(ctx, input)
	if err != nil || duplicate.Status != "succeeded" || duplicate.ProgressSeq != terminal.ProgressSeq {
		t.Fatalf("lost terminal: %+v %v", duplicate, err)
	}
	overwritten, err := s.Transition(ctx, input.ID, "failed", []byte("wrong"))
	if err != nil || string(overwritten.Result) != "original" {
		t.Fatal("terminal overwritten")
	}
	input.Hash = "changed"
	if _, err = s.Accept(ctx, input); !errors.Is(err, ErrConflict) {
		t.Fatal("payload conflict accepted")
	}
	if err = s.AcknowledgeTask(ctx, input.ID, terminal.ProgressSeq+1); !errors.Is(err, ErrConflict) {
		t.Fatal("future ACK accepted")
	}
	pending, err := s.PendingResults(ctx)
	if err != nil || len(pending) != 1 {
		t.Fatal("result lost before ACK")
	}
	if err = s.AcknowledgeTask(ctx, input.ID, terminal.ProgressSeq); err != nil {
		t.Fatal(err)
	}
	pending, err = s.PendingResults(ctx)
	if err != nil || len(pending) != 0 {
		t.Fatal("ACK not persisted")
	}
}
func TestMigrationChecksumsAndUniqueConstraints(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.db")
	s := openTest(t, path)
	if _, err := s.client.Stream.Create().SetID("s").Save(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.client.Stream.Create().SetID("s").Save(ctx); !ent.IsConstraintError(err) {
		t.Fatalf("missing unique constraint: %v", err)
	}
	s.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, "UPDATE schema_migrations SET checksum='tampered'"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if reopened, err := Open(ctx, path); err == nil {
		reopened.Close()
		t.Fatal("tampered migration accepted")
	}
}
func TestMultipleUsageStreamsHaveIndependentSequence(t *testing.T) {
	ctx := context.Background()
	s := openTest(t, filepath.Join(t.TempDir(), "state.db"))
	defer s.Close()
	for _, id := range []string{"a", "b"} {
		if _, err := s.RecordSample(ctx, id, []Counter{{"u", "r", 0, 0, 1, 0, false}}); err != nil {
			t.Fatal(err)
		}
		if b, err := s.RecordSample(ctx, id, []Counter{{"u", "r", 1, 0, 2, 0, false}}); err != nil || b.Seq != 1 {
			t.Fatalf("%+v %v", b, err)
		}
	}
}

func TestReviewedMigrationMatchesEntSchema(t *testing.T) {
	s := openTest(t, filepath.Join(t.TempDir(), "state.db"))
	defer s.Close()
	var ddl bytes.Buffer
	if err := s.client.Schema.WriteTo(context.Background(), &ddl); err != nil {
		t.Fatal(err)
	}
	for line := range strings.SplitSeq(ddl.String(), "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "PRAGMA ") {
			t.Fatalf("uncommitted schema drift: %s", ddl.String())
		}
	}
}
