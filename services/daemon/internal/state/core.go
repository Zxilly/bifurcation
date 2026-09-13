package state

import (
	"bytes"
	"context"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state/ent"
)

type CoreState struct {
	PolicyFloor                         int64
	Authorization                       []byte
	AppliedRevision                     string
	AppliedPolicy                       int64
	AppliedConfig                       []byte
	Stage, PendingTask, PendingRevision string
	PendingPolicy                       int64
	PendingConfig                       []byte
}

func coreDTO(row *ent.Core) CoreState {
	return CoreState{PolicyFloor: row.PolicyFloor, Authorization: row.Authorization, AppliedRevision: row.AppliedRevision, AppliedPolicy: row.AppliedPolicy, AppliedConfig: row.AppliedConfig, Stage: row.Stage, PendingTask: row.PendingTask, PendingRevision: row.PendingRevision, PendingPolicy: row.PendingPolicy, PendingConfig: row.PendingConfig}
}
func (s *Store) Core(ctx context.Context) (CoreState, error) {
	row, err := s.client.Core.Get(ctx, "core")
	if ent.IsNotFound(err) {
		return CoreState{Stage: "idle"}, nil
	}
	if err != nil {
		return CoreState{}, err
	}
	return coreDTO(row), nil
}
func (s *Store) PersistPolicy(ctx context.Context, revision int64, authorization []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	row, err := tx.Core.Get(ctx, "core")
	if ent.IsNotFound(err) {
		row, err = tx.Core.Create().SetID("core").Save(ctx)
	}
	if err != nil {
		return err
	}
	if revision < row.PolicyFloor || revision == row.PolicyFloor && len(row.Authorization) > 0 && !bytes.Equal(row.Authorization, authorization) {
		return ErrConflict
	}
	if _, err = tx.Core.UpdateOneID("core").SetPolicyFloor(revision).SetAuthorization(authorization).Save(ctx); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) PrepareCore(ctx context.Context, task, revision string, policy int64, config []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	row, err := tx.Core.Get(ctx, "core")
	if err != nil {
		return err
	}
	if policy < row.PolicyFloor {
		return ErrConflict
	}
	if row.Stage != "idle" && row.PendingTask != task {
		return ErrConflict
	}
	if _, err = tx.Core.UpdateOneID("core").SetStage("prepared").SetPendingTask(task).SetPendingRevision(revision).SetPendingPolicy(policy).SetPendingConfig(config).Save(ctx); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) CommitCore(ctx context.Context, revision string, policy int64, config []byte) error {
	return s.client.Core.UpdateOneID("core").SetAppliedRevision(revision).SetAppliedPolicy(policy).SetAppliedConfig(config).SetStage("idle").SetPendingTask("").SetPendingRevision("").SetPendingPolicy(0).ClearPendingConfig().Exec(ctx)
}
func (s *Store) AbortCore(ctx context.Context) error {
	return s.client.Core.UpdateOneID("core").SetStage("idle").SetPendingTask("").SetPendingRevision("").SetPendingPolicy(0).ClearPendingConfig().Exec(ctx)
}
