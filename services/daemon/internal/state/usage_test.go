package state

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"google.golang.org/protobuf/proto"
)

func TestLongRunningCoreSampleSplitsIntoAcceptedImmutableBatches(t *testing.T) {
	ctx := context.Background()
	store := openTest(t, filepath.Join(t.TempDir(), "state.db"))
	defer store.Close()
	var baseline, observed []Counter
	var expectedUpload, expectedDownload int64
	for i := range 10 {
		id := string(rune('a' + i))
		upload := int64(1<<54) + int64(i)
		download := int64(1003 + i)
		baseline = append(baseline, Counter{UserID: id, RuntimeID: "running-core", ObservedAt: 1000})
		observed = append(observed, Counter{UserID: id, RuntimeID: "running-core", Upload: upload, Download: download, ObservedAt: 1000 + 30*dayMilliseconds + 1234})
		expectedUpload += upload
		expectedDownload += download
	}
	if _, err := store.RecordSample(ctx, "stream", baseline); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecordSample(ctx, "stream", observed); err != nil {
		t.Fatal(err)
	}
	var upload, download, sequence int64
	for {
		batch, err := store.NextBatch(ctx, "stream")
		if err != nil {
			t.Fatal(err)
		}
		if batch == nil {
			break
		}
		sequence++
		if batch.Seq != sequence {
			t.Fatal("outbox sequence gap")
		}
		var message v1.UsageBatch
		if err = proto.Unmarshal(batch.Payload, &message); err != nil {
			t.Fatal(err)
		}
		if len(message.Deltas) > 256 || len(batch.Payload) > 1<<20 {
			t.Fatal("batch exceeds transport bounds")
		}
		cost := int64(0)
		for _, delta := range message.Deltas {
			duration := delta.EndUnixMs - delta.StartUnixMs
			if duration <= 0 || duration > dayMilliseconds || !delta.Estimated {
				t.Fatal("long interval was not split and marked estimated")
			}
			cost += duration/60_000 + 6
			upload += delta.UploadBytes
			download += delta.DownloadBytes
		}
		if cost > 8000 {
			t.Fatal("batch exceeds projection budget")
		}
		if err = store.AcknowledgeUsage(ctx, "stream", batch.Seq); err != nil {
			t.Fatal(err)
		}
	}
	if sequence < 2 || upload != expectedUpload || download != expectedDownload {
		t.Fatalf("split changed exact byte totals: batches=%d upload=%d/%d download=%d/%d", sequence, upload, expectedUpload, download, expectedDownload)
	}
	row, err := store.client.Stream.Get(ctx, "stream")
	if err != nil || row.PendingBytes != 0 {
		t.Fatal("ACK did not release outbox budget", err)
	}
}
func TestUsageRecoveryFenceSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.db")
	store := openTest(t, path)
	for _, sample := range []Counter{{"user", "core", 0, 0, 1, 0, false}, {"user", "core", 10, 0, 2, 0, false}} {
		if _, err := store.RecordSample(ctx, "stream", []Counter{sample}); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.RequireUsageRecovery(ctx, "stream", "panel restored an older backup"); err != nil {
		t.Fatal(err)
	}
	store.Close()
	store = openTest(t, path)
	defer store.Close()
	issue, err := store.UsageRecoveryIssue(ctx, "stream")
	if err != nil || issue == "" {
		t.Fatal("recovery fence lost", err)
	}
	batch, err := store.NextBatch(ctx, "stream")
	if err != nil || batch == nil || batch.Seq != 1 {
		t.Fatal("fenced stream lost unacknowledged data")
	}
}
func TestPolicyFloorRejectsRollbackAndChangedPayload(t *testing.T) {
	ctx := context.Background()
	store := openTest(t, filepath.Join(t.TempDir(), "state.db"))
	defer store.Close()
	if err := store.PersistPolicy(ctx, 1, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := store.PersistPolicy(ctx, 2, []byte("revoked")); err != nil {
		t.Fatal(err)
	}
	for _, attempt := range []struct {
		revision int64
		body     string
	}{{1, "first"}, {2, "different"}} {
		if err := store.PersistPolicy(ctx, attempt.revision, []byte(attempt.body)); !errors.Is(err, ErrConflict) {
			t.Fatal("policy floor or immutable revision violated", err)
		}
	}
	saved, err := store.Core(ctx)
	if err != nil || saved.PolicyFloor != 2 || string(saved.Authorization) != "revoked" {
		t.Fatal("latest policy was not preserved", err)
	}
}

func TestManagedRuntimeAccountsForTrafficBeforeItsFirstSample(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state.db")
	store := openTest(t, path)
	first, err := store.RecordSample(ctx, "managed", []Counter{{UserID: "user", RuntimeID: "runtime-1", StartedAt: 1000, ObservedAt: 2000, Upload: 11, Download: 4}})
	if err != nil || first == nil {
		t.Fatalf("first managed traffic was not queued: %v %v", first, err)
	}
	var message v1.UsageBatch
	if err = proto.Unmarshal(first.Payload, &message); err != nil {
		t.Fatal(err)
	}
	if len(message.Deltas) != 1 || message.Deltas[0].StartUnixMs != 1000 || message.Deltas[0].UploadBytes != 11 || message.Deltas[0].DownloadBytes != 4 {
		t.Fatalf("first managed bytes lost: %+v", &message)
	}
	if err = store.AcknowledgeUsage(ctx, "managed", first.Seq); err != nil {
		t.Fatal(err)
	}
	restarted, err := store.RecordSample(ctx, "managed", []Counter{{UserID: "user", RuntimeID: "runtime-2", StartedAt: 2500, ObservedAt: 3000, Upload: 7, Download: 8}})
	if err != nil || restarted == nil {
		t.Fatal(err)
	}
	message = v1.UsageBatch{}
	if err = proto.Unmarshal(restarted.Payload, &message); err != nil {
		t.Fatal(err)
	}
	if len(message.Deltas) != 2 {
		t.Fatalf("expected separate old tail gap and new known bytes: %+v", &message)
	}
	gap, data := message.Deltas[0], message.Deltas[1]
	if !gap.Incomplete || gap.StartUnixMs != 2000 || gap.EndUnixMs != 2500 || gap.UploadBytes != 0 || gap.DownloadBytes != 0 {
		t.Fatalf("wrong old tail gap: %+v", gap)
	}
	if data.StartUnixMs != 2500 || data.EndUnixMs != 3000 || data.UploadBytes != 7 || data.DownloadBytes != 8 {
		t.Fatalf("new runtime bytes were discarded: %+v", data)
	}
	if err = store.AcknowledgeUsage(ctx, "managed", restarted.Seq); err != nil {
		t.Fatal(err)
	}
	store.Close()
	store = openTest(t, path)
	defer store.Close()
	next, err := store.RecordSample(ctx, "managed", []Counter{{UserID: "user", RuntimeID: "runtime-2", StartedAt: 2500, ObservedAt: 4000, Upload: 12, Download: 9}})
	if err != nil {
		t.Fatal(err)
	}
	message = v1.UsageBatch{}
	if err = proto.Unmarshal(next.Payload, &message); err != nil {
		t.Fatal(err)
	}
	if len(message.Deltas) != 1 || message.Deltas[0].UploadBytes != 5 || message.Deltas[0].DownloadBytes != 1 {
		t.Fatal("daemon restart counted the new baseline twice", &message)
	}
	freshUser, err := store.RecordSample(ctx, "managed", []Counter{{UserID: "new-user", RuntimeID: "runtime-2", StartedAt: 2500, ObservedAt: 4500, Upload: 3, Download: 6}})
	if err != nil || freshUser == nil {
		t.Fatal("new user's existing runtime traffic was dropped", err)
	}
	message = v1.UsageBatch{}
	if err = proto.Unmarshal(freshUser.Payload, &message); err != nil {
		t.Fatal(err)
	}
	if message.Deltas[0].UploadBytes != 3 || message.Deltas[0].DownloadBytes != 6 {
		t.Fatal("new user's first counters were not accounted", &message)
	}
}

func TestUnknownExistingCoreStillUsesFirstAdoptionBaseline(t *testing.T) {
	ctx := context.Background()
	store := openTest(t, filepath.Join(t.TempDir(), "state.db"))
	defer store.Close()
	first, err := store.RecordSample(ctx, "unknown", []Counter{{UserID: "user", RuntimeID: "existing", ObservedAt: 1000, Upload: 1000, Download: 500}})
	if err != nil || first != nil {
		t.Fatal("pre-adoption traffic was attributed", err)
	}
	next, err := store.RecordSample(ctx, "unknown", []Counter{{UserID: "user", RuntimeID: "existing", ObservedAt: 2000, Upload: 1100, Download: 550}})
	if err != nil {
		t.Fatal(err)
	}
	var message v1.UsageBatch
	if err = proto.Unmarshal(next.Payload, &message); err != nil {
		t.Fatal(err)
	}
	if message.Deltas[0].UploadBytes != 100 || message.Deltas[0].DownloadBytes != 50 {
		t.Fatal("unknown baseline was not retained", &message)
	}
}

func TestGracefulFinalAndNewDirtyBaselineDistinguishCrash(t *testing.T) {
	ctx := context.Background()
	store := openTest(t, filepath.Join(t.TempDir(), "state.db"))
	defer store.Close()
	samples := []Counter{
		{UserID: "user", RuntimeID: "one", StartedAt: 1000, ObservedAt: 1000},
		{UserID: "user", RuntimeID: "one", StartedAt: 1000, ObservedAt: 2000, Upload: 10, Download: 20, Final: true},
		{UserID: "user", RuntimeID: "two", StartedAt: 3000, ObservedAt: 3000},
	}
	for _, sample := range samples {
		if _, err := store.RecordSample(ctx, "stream", []Counter{sample}); err != nil {
			t.Fatal(err)
		}
	}
	first, err := store.NextBatch(ctx, "stream")
	if err != nil || first == nil {
		t.Fatal(err)
	}
	var message v1.UsageBatch
	if err = proto.Unmarshal(first.Payload, &message); err != nil {
		t.Fatal(err)
	}
	if len(message.Deltas) != 1 || message.Deltas[0].Incomplete {
		t.Fatal("normal final sample produced a gap")
	}
	if err = store.AcknowledgeUsage(ctx, "stream", first.Seq); err != nil {
		t.Fatal(err)
	}
	// Runtime two crashed before any periodic sample; its dirty zero baseline exists.
	crash, err := store.RecordSample(ctx, "stream", []Counter{{UserID: "user", RuntimeID: "three", StartedAt: 4000, ObservedAt: 4001}})
	if err != nil || crash == nil {
		t.Fatal("first-sample crash was mistaken for a clean close", err)
	}
	message = v1.UsageBatch{}
	if err = proto.Unmarshal(crash.Payload, &message); err != nil {
		t.Fatal(err)
	}
	if len(message.Deltas) != 1 || !message.Deltas[0].Incomplete || message.Deltas[0].StartUnixMs != 3000 || message.Deltas[0].EndUnixMs != 4000 {
		t.Fatal("dirty runtime gap is wrong", &message)
	}
}
