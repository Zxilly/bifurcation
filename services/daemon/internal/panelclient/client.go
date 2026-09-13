package panelclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"runtime"
	"sync"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1/bifurcationv1connect"
	"github.com/Zxilly/bifurcation/services/daemon/internal/core"
	"github.com/Zxilly/bifurcation/services/daemon/internal/identity"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	"github.com/Zxilly/bifurcation/services/daemon/internal/system"
	"github.com/Zxilly/bifurcation/services/daemon/internal/systemmetrics"
	"github.com/Zxilly/bifurcation/services/daemon/internal/updater"
)

type taskJob struct {
	sessionEpoch int64
	notice       *v1.TaskAvailable
}
type Client struct {
	rpc                       bifurcationv1connect.MachineServiceClient
	token, directory, version string
	identity                  identity.Identity
	identityMu                sync.RWMutex
	store                     *state.Store
	log                       *slog.Logger
	core                      core.Adapter
	maintenance               *updater.Controller
	metrics                   *systemmetrics.Sampler
	jobs                      chan taskJob
	failures                  chan error
	queueMu                   sync.Mutex
	queued                    map[string]bool
	collectMu                 sync.Mutex
	issueMu                   sync.RWMutex
	usageIssue                string
	reportIssue               string
}

func New(config identity.Config, id identity.Identity, store *state.Store, version string, logger *slog.Logger) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	httpClient := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &Client{rpc: bifurcationv1connect.NewMachineServiceClient(httpClient, config.PanelURL+"/rpc", connect.WithReadMaxBytes(4<<20)), token: config.Token, directory: config.StateDirectory, identity: id, store: store, version: version, log: logger, jobs: make(chan taskJob, 16), failures: make(chan error, 1), queued: map[string]bool{}, metrics: systemmetrics.New()}
}
func (c *Client) SetCore(adapter core.Adapter) {
	c.core = adapter
	if adapter != nil {
		adapter.SetFinalSample(c.finalSample)
	}
}
func (c *Client) SetMaintenance(controller *updater.Controller) { c.maintenance = controller }
func (c *Client) installation() *v1.Installation {
	c.identityMu.RLock()
	defer c.identityMu.RUnlock()
	return &v1.Installation{InstallationId: c.identity.InstallationID, BindingEpoch: c.identity.BindingEpoch}
}
func request[T any](c *Client, message *T) *connect.Request[T] {
	r := connect.NewRequest(message)
	r.Header().Set("Authorization", "Bearer "+c.token)
	return r
}
func (c *Client) Run(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	var workers sync.WaitGroup
	workers.Add(2)
	go func() { defer workers.Done(); c.taskWorker(ctx) }()
	go func() { defer workers.Done(); c.collectLoop(ctx) }()
	defer func() { cancel(); workers.Wait() }()
	delay := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if connect.CodeOf(err) == connect.CodeUnauthenticated || connect.CodeOf(err) == connect.CodePermissionDenied || errors.Is(err, state.ErrConflict) {
			return err
		}
		c.log.Warn("panel connection ended", "error", err)
		if time.Since(start) > time.Minute {
			delay = time.Second
		}
		timer := time.NewTimer(delay + time.Duration(rand.Int64N(int64(delay/2)+1)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
		delay = min(delay*2, 30*time.Second)
	}
	return ctx.Err()
}
func (c *Client) taskWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-c.jobs:
			err := c.execute(ctx, job.sessionEpoch, job.notice)
			c.queueMu.Lock()
			delete(c.queued, job.notice.TaskId)
			c.queueMu.Unlock()
			if err != nil {
				select {
				case c.failures <- err:
				default:
				}
			}
		}
	}
}
func (c *Client) queueTask(ctx context.Context, epoch int64, notice *v1.TaskAvailable) error {
	c.queueMu.Lock()
	if c.queued[notice.TaskId] {
		c.queueMu.Unlock()
		return nil
	}
	c.queued[notice.TaskId] = true
	c.queueMu.Unlock()
	select {
	case c.jobs <- taskJob{epoch, notice}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (c *Client) session(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	supported := []v1.TaskKind{v1.TaskKind_TASK_KIND_INSPECT}
	if c.core != nil && runtime.GOOS == "linux" {
		supported = append(supported, v1.TaskKind_TASK_KIND_APPLY_CONFIG)
	}
	if c.maintenance != nil && c.maintenance.Supported() {
		supported = append(supported, v1.TaskKind_TASK_KIND_UPGRADE_DAEMON, v1.TaskKind_TASK_KIND_UNINSTALL)
	}
	stream, err := c.rpc.WatchTasks(ctx, request(c, &v1.WatchTasksRequest{Installation: c.installation(), DaemonVersion: c.version, ProtocolVersion: 1, SupportedTasks: supported, Os: runtime.GOOS, Arch: runtime.GOARCH}))
	if err != nil {
		return err
	}
	defer stream.Close()
	type event struct {
		message *v1.WatchTasksResponse
		err     error
	}
	events := make(chan event, 1)
	go func() {
		for stream.Receive() {
			select {
			case events <- event{message: stream.Msg()}:
			case <-ctx.Done():
				return
			}
		}
		err := stream.Err()
		if err == nil {
			err = io.EOF
		}
		select {
		case events <- event{err: err}:
		case <-ctx.Done():
		}
	}()
	idle := time.NewTimer(45 * time.Second)
	defer idle.Stop()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	var sessionEpoch, sequence int64
	idleDuration := 45 * time.Second
	report := func() error {
		if sessionEpoch == 0 {
			return nil
		}
		sequence++
		callCtx, stop := context.WithTimeout(ctx, 15*time.Second)
		defer stop()
		_, err := c.rpc.ReportStatus(callCtx, request(c, &v1.ReportStatusRequest{Installation: c.installation(), SessionEpoch: sessionEpoch, Sequence: sequence, Status: c.status(callCtx)}))
		if err != nil {
			return err
		}
		if err = c.flushResults(callCtx); err != nil {
			return err
		}
		return c.flushUsage(callCtx)
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-c.failures:
			return err
		case <-idle.C:
			return errors.New("panel heartbeat timed out")
		case <-ticker.C:
			if err = report(); err != nil {
				return err
			}
		case e := <-events:
			if e.err != nil {
				return e.err
			}
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(idleDuration)
			switch message := e.message.Event.(type) {
			case *v1.WatchTasksResponse_Session:
				if sessionEpoch != 0 || message.Session.SessionEpoch <= 0 {
					return state.ErrConflict
				}
				c.identityMu.Lock()
				err = identity.SaveBinding(c.directory, &c.identity, message.Session.BindingEpoch)
				c.identityMu.Unlock()
				if err != nil {
					return fmt.Errorf("%w: %v", state.ErrConflict, err)
				}
				sessionEpoch = message.Session.SessionEpoch
				idleDuration = time.Duration(max(10, min(300, message.Session.HeartbeatSeconds))) * 3 * time.Second
				idle.Reset(idleDuration)
				ticker.Reset(time.Duration(max(5, min(300, message.Session.StatusIntervalSeconds))) * time.Second)
				if err = report(); err != nil {
					return err
				}
			case *v1.WatchTasksResponse_Task:
				if sessionEpoch == 0 {
					return state.ErrConflict
				}
				if err = c.queueTask(ctx, sessionEpoch, message.Task); err != nil {
					return err
				}
			case *v1.WatchTasksResponse_Heartbeat:
				if sessionEpoch == 0 {
					return state.ErrConflict
				}
			default:
				return errors.New("unknown stream event")
			}
		}
	}
}
func (c *Client) status(ctx context.Context) *v1.MachineStatus {
	result := &v1.MachineStatus{ObservedAtUnixMs: time.Now().UnixMilli(), DaemonVersion: c.version, CoreHealth: v1.CoreHealth_CORE_HEALTH_UNSPECIFIED, UsageIncomplete: true, Issue: "Proxy core status is not available"}
	if c.metrics != nil {
		snapshot := c.metrics.Read(c.directory)
		result.CpuUsagePercent = snapshot.CPUUsagePercent
		result.MemoryUsedBytes = snapshot.MemoryUsedBytes
		result.MemoryTotalBytes = snapshot.MemoryTotalBytes
		result.DiskFreeBytes = snapshot.DiskFreeBytes
		result.NetworkRxBytes = snapshot.NetworkRXBytes
		result.NetworkTxBytes = snapshot.NetworkTXBytes
		result.NetworkInterface = snapshot.NetworkInterface
	}
	if c.core != nil {
		health, err := c.core.Health(ctx)
		if err != nil {
			result.Issue = err.Error()
		} else {
			result.Connections = health.Connections
			result.CoreVersion = health.Version
			result.CoreRuntimeId = health.RuntimeID
			result.AppliedRevisionId = health.RevisionID
			result.AppliedPolicyRevision = health.PolicyRevision
			result.AppliedConfigSha256 = health.ConfigSHA256
			result.Issue = health.Issue
			if !health.Configured {
				result.CoreHealth = v1.CoreHealth_CORE_HEALTH_NOT_CONFIGURED
			} else if health.Healthy {
				result.CoreHealth = v1.CoreHealth_CORE_HEALTH_HEALTHY
				result.UsageIncomplete = false
			} else {
				result.CoreHealth = v1.CoreHealth_CORE_HEALTH_UNHEALTHY
			}
		}
	}
	c.issueMu.RLock()
	issue := c.usageIssue
	if c.reportIssue != "" {
		if issue != "" {
			issue += "; "
		}
		issue += c.reportIssue
	}
	c.issueMu.RUnlock()
	if backlog := c.persistentUsageIssue(ctx); backlog != "" {
		result.UsageIncomplete = true
		if issue == "" {
			issue = backlog
		}
	}
	if issue != "" {
		result.UsageIncomplete = true
		if result.Issue == "" {
			result.Issue = issue
		}
	}
	if len(result.Issue) > 4096 {
		result.Issue = system.LimitString(result.Issue, 4096)
	}
	return result
}
