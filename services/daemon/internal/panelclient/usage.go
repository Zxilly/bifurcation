package panelclient

import (
	"context"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/internal/core"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
)

func (c *Client) usageStream() string { return "usage-" + c.installation().InstallationId }
func (c *Client) collectLoop(ctx context.Context) {
	if c.core == nil {
		return
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := c.collect(ctx); err != nil && !errors.Is(err, core.ErrNotConfigured) && !errors.Is(err, context.Canceled) {
				c.log.Warn("usage sampling failed", "error", err)
			}
		}
	}
}
func (c *Client) collect(ctx context.Context) error {
	if c.core == nil {
		return nil
	}
	c.collectMu.Lock()
	defer c.collectMu.Unlock()
	return c.collectLocked(ctx)
}
func (c *Client) finalSample(ctx context.Context, counters []core.Counter) error {
	c.collectMu.Lock()
	defer c.collectMu.Unlock()
	return c.recordCounters(ctx, counters)
}
func (c *Client) recordCounters(ctx context.Context, counters []core.Counter) error {
	records := make([]state.Counter, 0, len(counters))
	for _, counter := range counters {
		records = append(records, state.Counter{UserID: counter.UserID, RuntimeID: counter.RuntimeID, Upload: counter.Upload, Download: counter.Download, ObservedAt: counter.ObservedAt, StartedAt: counter.StartedAt, Final: counter.Final})
	}
	if len(records) == 0 {
		return nil
	}
	_, err := c.store.RecordSample(ctx, c.usageStream(), records)
	return err
}
func (c *Client) collectLocked(ctx context.Context) error {
	sampleCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	counters, err := c.core.ReadCounters(sampleCtx)
	if err == nil {
		err = c.recordCounters(sampleCtx, counters)
		if err == nil && len(counters) > 0 && counters[0].Final {
			c.core.AcknowledgeFinalSample(counters[0].RuntimeID)
		}
	}
	c.issueMu.Lock()
	if err == nil {
		c.usageIssue = ""
	} else if !errors.Is(err, core.ErrNotConfigured) {
		c.usageIssue = err.Error()
	}
	c.issueMu.Unlock()
	return err
}
func (c *Client) flushUsage(ctx context.Context) error {
	recovery, err := c.store.UsageRecoveryIssue(ctx, c.usageStream())
	if err != nil {
		return err
	}
	if recovery != "" {
		c.issueMu.Lock()
		c.reportIssue = recovery
		c.issueMu.Unlock()
		return nil
	}
	// A bounded drain catches up faster than the sampling rate without occupying a
	// request indefinitely. Each immutable batch waits for its own committed ACK.
	for range 128 {
		batch, err := c.store.NextBatch(ctx, c.usageStream())
		if err != nil {
			return err
		}
		if batch == nil {
			c.issueMu.Lock()
			c.reportIssue = ""
			c.issueMu.Unlock()
			return nil
		}
		response, err := c.rpc.ReportUsage(ctx, request(c, &v1.ReportUsageRequest{Installation: c.installation(), StreamId: batch.StreamID, Sequence: batch.Seq, Payload: batch.Payload, PayloadSha256: batch.Hash}))
		if err != nil {
			if connect.CodeOf(err) == connect.CodeUnauthenticated {
				return err
			}
			c.issueMu.Lock()
			c.reportIssue = "Usage report is pending: " + err.Error()
			c.issueMu.Unlock()
			return nil
		}
		if response.Msg.CommittedSequence < batch.Seq {
			c.issueMu.Lock()
			c.reportIssue = fmt.Sprintf("Usage stream requires recovery: panel expects %d, earliest retained sequence is %d", response.Msg.ExpectedSequence, batch.Seq)
			c.issueMu.Unlock()
			return c.store.RequireUsageRecovery(ctx, batch.StreamID, c.reportIssue)
		}
		if err = c.store.AcknowledgeUsage(ctx, batch.StreamID, response.Msg.CommittedSequence); err != nil {
			c.issueMu.Lock()
			c.reportIssue = err.Error()
			c.issueMu.Unlock()
			return nil
		}
	}
	c.issueMu.Lock()
	c.reportIssue = "Usage backlog is still being sent"
	c.issueMu.Unlock()
	return nil
}

func (c *Client) persistentUsageIssue(ctx context.Context) string {
	queue, err := c.store.UsageQueue(ctx, c.usageStream())
	if err != nil {
		return "Usage queue cannot be inspected: " + err.Error()
	}
	if queue.RecoveryIssue != "" {
		return queue.RecoveryIssue
	}
	if queue.PendingBatches > 128 || queue.PendingBatches > 0 && queue.OldestEnd > 0 && queue.OldestEnd < time.Now().Add(-30*time.Second).UnixMilli() {
		return fmt.Sprintf("Usage backlog pending: %d batches", queue.PendingBatches)
	}
	return ""
}
