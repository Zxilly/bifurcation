package state

import (
	"context"
	"errors"
	"fmt"

	"github.com/Zxilly/bifurcation/services/daemon/internal/state/ent"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state/ent/task"
)

var ErrConflict = errors.New("persistent identity or payload conflict")

type Task struct {
	ID, Hash, Kind, Status    string
	Payload, Result           []byte
	BindingEpoch, ProgressSeq int64
	Acknowledged              bool
}

func taskDTO(t *ent.Task) Task {
	return Task{ID: t.ID, Hash: t.PayloadHash, Kind: t.Kind, Status: string(t.Status), Payload: t.Payload, Result: t.Result, BindingEpoch: t.BindingEpoch, ProgressSeq: t.ProgressSeq, Acknowledged: t.Acknowledged}
}

// Accept records a panel-accepted task before any side effect. Duplicates retain local progress.
func (s *Store) Accept(ctx context.Context, t Task) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback()
	old, err := tx.Task.Get(ctx, t.ID)
	if err == nil {
		if old.PayloadHash != t.Hash || old.BindingEpoch != t.BindingEpoch || old.Kind != t.Kind {
			return Task{}, ErrConflict
		}
		return taskDTO(old), nil
	}
	if !ent.IsNotFound(err) {
		return Task{}, err
	}
	row, err := tx.Task.Create().SetID(t.ID).SetPayloadHash(t.Hash).SetKind(t.Kind).SetPayload(t.Payload).SetBindingEpoch(t.BindingEpoch).Save(ctx)
	if err != nil {
		return Task{}, err
	}
	if err = tx.Commit(); err != nil {
		return Task{}, err
	}
	return taskDTO(row), nil
}
func (s *Store) Task(ctx context.Context, id string) (Task, error) {
	row, err := s.client.Task.Get(ctx, id)
	if err != nil {
		return Task{}, err
	}
	return taskDTO(row), nil
}

// Transition is monotonic: terminal tasks cannot be executed or overwritten again.
func (s *Store) Transition(ctx context.Context, id, status string, result []byte) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback()
	row, err := tx.Task.Get(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if row.Status == task.StatusSucceeded || row.Status == task.StatusFailed {
		return taskDTO(row), nil
	}
	if status != "running" && status != "succeeded" && status != "failed" {
		return Task{}, fmt.Errorf("invalid task transition: %s", status)
	}
	updated, err := tx.Task.UpdateOneID(id).SetStatus(task.Status(status)).AddProgressSeq(1).SetResult(result).Save(ctx)
	if err != nil {
		return Task{}, err
	}
	if err = tx.Commit(); err != nil {
		return Task{}, err
	}
	return taskDTO(updated), nil
}
func (s *Store) PendingResults(ctx context.Context) ([]Task, error) {
	rows, err := s.client.Task.Query().Where(task.Acknowledged(false), task.StatusIn(task.StatusSucceeded, task.StatusFailed)).All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Task, 0, len(rows))
	for _, row := range rows {
		result = append(result, taskDTO(row))
	}
	return result, nil
}
func (s *Store) AcknowledgeTask(ctx context.Context, id string, seq int64) error {
	n, err := s.client.Task.Update().Where(task.ID(id), task.ProgressSeq(seq), task.StatusIn(task.StatusSucceeded, task.StatusFailed)).SetAcknowledged(true).Save(ctx)
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConflict
	}
	return nil
}
