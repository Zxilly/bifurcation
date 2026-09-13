package state

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"math/big"

	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state/ent"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state/ent/batch"
	"google.golang.org/protobuf/proto"
)

type Counter struct {
	UserID, RuntimeID            string
	Upload, Download, ObservedAt int64
	StartedAt                    int64
	Final                        bool
}
type Delta struct {
	UserID                       string
	Start, End, Upload, Download int64
	Incomplete, Estimated        bool
}
type Batch struct {
	Seq            int64
	StreamID, Hash string
	Payload        []byte
}

var ErrCounterRegression = errors.New("counter or clock regressed")
var ErrSequence = errors.New("usage acknowledgement outside persisted range")
var ErrOutboxFull = errors.New("usage outbox disk budget reached; retaining counters until reports are acknowledged")

const outboxBudget int64 = 64 << 20
const dayMilliseconds int64 = 24 * 60 * 60 * 1000

// RecordSample commits counters with immutable batches. StartedAt identifies a
// managed zero baseline; zero retains the unknown-process takeover behavior.
func (s *Store) RecordSample(ctx context.Context, streamID string, counters []Counter) (*Batch, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	st, err := tx.Stream.Get(ctx, streamID)
	if ent.IsNotFound(err) {
		st, err = tx.Stream.Create().SetID(streamID).Save(ctx)
	}
	if err != nil {
		return nil, err
	}
	deltas := make([]Delta, 0, len(counters))
	seen := map[string]bool{}
	runtimeID := ""
	for _, c := range counters {
		if runtimeID == "" {
			runtimeID = c.RuntimeID
		}
		if c.RuntimeID != runtimeID {
			return nil, ErrCounterRegression
		}
		if c.UserID == "" || c.RuntimeID == "" || c.Upload < 0 || c.Download < 0 || c.ObservedAt < 0 || c.ObservedAt > 1<<53-1 || c.StartedAt < 0 || c.StartedAt > c.ObservedAt || seen[c.UserID] {
			return nil, ErrCounterRegression
		}
		seen[c.UserID] = true
		id := fmt.Sprintf("%d:%s%s", len(streamID), streamID, c.UserID)
		old, e := tx.Cursor.Get(ctx, id)
		if ent.IsNotFound(e) {
			first, e := managedInitialDelta(c, false)
			if e != nil {
				return nil, e
			}
			deltas = append(deltas, first...)
			_, err = tx.Cursor.Create().SetID(id).SetRuntimeID(c.RuntimeID).SetUpload(c.Upload).SetDownload(c.Download).SetObservedAt(c.ObservedAt).SetClosed(c.Final).Save(ctx)
		} else if e != nil {
			return nil, e
		} else {
			if old.Closed && old.RuntimeID == c.RuntimeID && !c.Final {
				if c.ObservedAt <= old.ObservedAt && c.Upload <= old.Upload && c.Download <= old.Download {
					continue
				}
				return nil, ErrCounterRegression
			}
			if c.ObservedAt < old.ObservedAt {
				return nil, ErrCounterRegression
			}
			if old.RuntimeID == c.RuntimeID {
				if c.Upload < old.Upload || c.Download < old.Download {
					return nil, ErrCounterRegression
				}
				upload, download := c.Upload-old.Upload, c.Download-old.Download
				if c.ObservedAt == old.ObservedAt && (upload != 0 || download != 0) || upload > math.MaxInt64-download {
					return nil, ErrCounterRegression
				}
				if upload != 0 || download != 0 {
					deltas = append(deltas, Delta{UserID: c.UserID, Start: old.ObservedAt, End: c.ObservedAt, Upload: upload, Download: download, Estimated: c.ObservedAt-old.ObservedAt > 10_000})
				}
			} else {
				gapEnd := c.ObservedAt
				if c.StartedAt > 0 {
					gapEnd = c.StartedAt
				}
				if !old.Closed && gapEnd > old.ObservedAt {
					deltas = append(deltas, Delta{UserID: c.UserID, Start: old.ObservedAt, End: gapEnd, Incomplete: true, Estimated: true})
				}
				first, e := managedInitialDelta(c, !old.Closed && c.StartedAt > 0 && c.StartedAt <= old.ObservedAt)
				if e != nil {
					return nil, e
				}
				deltas = append(deltas, first...)
			}
			_, err = tx.Cursor.UpdateOneID(id).SetRuntimeID(c.RuntimeID).SetUpload(c.Upload).SetDownload(c.Download).SetObservedAt(c.ObservedAt).SetClosed(c.Final).Save(ctx)
		}
		if err != nil {
			return nil, err
		}
	}
	messages := batchDeltas(runtimeID, deltas)
	var first *Batch
	pendingBytes := st.PendingBytes
	for i, message := range messages {
		if int64(i) >= math.MaxInt64-st.NextSeq {
			return nil, ErrSequence
		}
		seq := st.NextSeq + int64(i)
		payload, err := proto.Marshal(message)
		if err != nil {
			return nil, err
		}
		if len(payload) > 1<<20 || pendingBytes > outboxBudget-int64(len(payload)) {
			return nil, ErrOutboxFull
		}
		pendingBytes += int64(len(payload))
		sum := sha256.Sum256(payload)
		hash := hex.EncodeToString(sum[:])
		_, err = tx.Batch.Create().SetID(fmt.Sprintf("%s:%d", streamID, seq)).SetSeq(seq).SetStreamID(streamID).SetPayload(payload).SetSizeBytes(int64(len(payload))).SetPayloadHash(hash).Save(ctx)
		if err != nil {
			return nil, err
		}
		if first == nil {
			first = &Batch{seq, streamID, hash, payload}
		}
	}
	if len(messages) > 0 {
		if _, err = tx.Stream.UpdateOneID(streamID).AddNextSeq(int64(len(messages))).SetPendingBytes(pendingBytes).Save(ctx); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return first, nil
}
func scaledBytes(total, offset, duration int64) int64 {
	var value big.Int
	value.Mul(big.NewInt(total), big.NewInt(offset))
	value.Quo(&value, big.NewInt(duration))
	return value.Int64()
}

// A conservative projection budget bounds the receiving panel's minute/day/month
// transaction as well as its 256-delta limit. Every source byte is preserved.
func batchDeltas(runtimeID string, deltas []Delta) []*v1.UsageBatch {
	result := []*v1.UsageBatch{}
	message := &v1.UsageBatch{CoreRuntimeId: runtimeID}
	projections := int64(0)
	flush := func() {
		if len(message.Deltas) > 0 {
			result = append(result, message)
			message = &v1.UsageBatch{CoreRuntimeId: runtimeID}
			projections = 0
		}
	}
	for _, delta := range deltas {
		duration := delta.End - delta.Start
		for start := delta.Start; start < delta.End; {
			end := min(delta.End, start+dayMilliseconds)
			cost := (end-start)/60_000 + 6
			if len(message.Deltas) >= 256 || projections+cost > 8000 {
				flush()
			}
			upload := scaledBytes(delta.Upload, end-delta.Start, duration) - scaledBytes(delta.Upload, start-delta.Start, duration)
			download := scaledBytes(delta.Download, end-delta.Start, duration) - scaledBytes(delta.Download, start-delta.Start, duration)
			message.Deltas = append(message.Deltas, &v1.UsageDelta{UserId: delta.UserID, StartUnixMs: start, EndUnixMs: end, UploadBytes: upload, DownloadBytes: download, Incomplete: delta.Incomplete, Estimated: delta.Estimated || duration > dayMilliseconds})
			projections += cost
			start = end
		}
	}
	flush()
	return result
}
func (s *Store) NextBatch(ctx context.Context, streamID string) (*Batch, error) {
	row, err := s.client.Batch.Query().Where(batch.StreamID(streamID)).Order(ent.Asc(batch.FieldSeq)).First(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &Batch{row.Seq, row.StreamID, row.PayloadHash, row.Payload}, nil
}
func (s *Store) AcknowledgeUsage(ctx context.Context, streamID string, seq int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	st, err := tx.Stream.Get(ctx, streamID)
	if err != nil {
		return err
	}
	if seq < st.CommittedSeq || seq >= st.NextSeq {
		return ErrSequence
	}
	rows, err := tx.Batch.Query().Where(batch.StreamID(streamID), batch.SeqLTE(seq)).All(ctx)
	if err != nil {
		return err
	}
	var size int64
	for _, row := range rows {
		size += row.SizeBytes
	}
	if _, err = tx.Batch.Delete().Where(batch.StreamID(streamID), batch.SeqLTE(seq)).Exec(ctx); err != nil {
		return err
	}
	if _, err = tx.Stream.UpdateOneID(streamID).SetCommittedSeq(seq).SetPendingBytes(max(0, st.PendingBytes-size)).Save(ctx); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) UsageRecoveryIssue(ctx context.Context, streamID string) (string, error) {
	row, err := s.client.Stream.Get(ctx, streamID)
	if ent.IsNotFound(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return row.RecoveryIssue, nil
}
func (s *Store) RequireUsageRecovery(ctx context.Context, streamID, message string) error {
	return s.client.Stream.UpdateOneID(streamID).SetRecoveryIssue(message).Exec(ctx)
}

// A managed core's counters start at zero at StartedAt, even if its first sample
// already contains traffic. Unknown first adoption deliberately uses a baseline.
func managedInitialDelta(counter Counter, incomplete bool) ([]Delta, error) {
	if counter.StartedAt == 0 || counter.Upload == 0 && counter.Download == 0 {
		return nil, nil
	}
	if counter.StartedAt >= counter.ObservedAt || counter.Upload > math.MaxInt64-counter.Download {
		return nil, ErrCounterRegression
	}
	return []Delta{{UserID: counter.UserID, Start: counter.StartedAt, End: counter.ObservedAt, Upload: counter.Upload, Download: counter.Download, Estimated: true, Incomplete: incomplete}}, nil
}
