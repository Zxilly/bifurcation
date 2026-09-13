package state

import (
	"context"
	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state/ent"
	"google.golang.org/protobuf/proto"
)

type UsageQueueStatus struct {
	PendingBatches int64
	OldestEnd      int64
	RecoveryIssue  string
}

func (s *Store) UsageQueue(ctx context.Context, streamID string) (UsageQueueStatus, error) {
	stream, err := s.client.Stream.Get(ctx, streamID)
	if ent.IsNotFound(err) {
		return UsageQueueStatus{}, nil
	}
	if err != nil {
		return UsageQueueStatus{}, err
	}
	result := UsageQueueStatus{PendingBatches: stream.NextSeq - stream.CommittedSeq - 1, RecoveryIssue: stream.RecoveryIssue}
	if result.PendingBatches > 0 {
		batch, err := s.NextBatch(ctx, streamID)
		if err != nil {
			return result, err
		}
		if batch != nil {
			var message v1.UsageBatch
			if err = proto.Unmarshal(batch.Payload, &message); err != nil {
				return result, err
			}
			for _, delta := range message.Deltas {
				if result.OldestEnd == 0 || delta.EndUnixMs < result.OldestEnd {
					result.OldestEnd = delta.EndUnixMs
				}
			}
		}
	}
	return result, nil
}
