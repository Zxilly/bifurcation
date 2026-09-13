package singbox

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/Zxilly/bifurcation/services/daemon/internal/core"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	sj "github.com/sagernet/sing/common/json"
)

type instance struct {
	box       *box.Box
	tracker   *Tracker
	cancel    context.CancelFunc
	runtimeID string
	startedAt int64
	users     []string
}
type Adapter struct {
	store        *state.Store
	directory    string
	opMu         sync.Mutex
	mu           sync.RWMutex
	active       *instance
	closing      bool
	issue        string
	logs         logBuffer
	finalSample  func(context.Context, []core.Counter) error
	pendingFinal [][]core.Counter
}

func New(store *state.Store, directory string) *Adapter {
	return &Adapter{store: store, directory: filepath.Join(directory, "core")}
}
func (a *Adapter) SetFinalSample(callback func(context.Context, []core.Counter) error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.finalSample = callback
}
func (a *Adapter) AcknowledgeFinalSample(runtimeID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for i, sample := range a.pendingFinal {
		if len(sample) > 0 && sample[0].RuntimeID == runtimeID {
			a.pendingFinal = append(a.pendingFinal[:i], a.pendingFinal[i+1:]...)
			break
		}
	}
	if len(a.pendingFinal) == 0 {
		a.issue = ""
	}
}
func (a *Adapter) Health(ctx context.Context) (core.Health, error) {
	saved, err := a.store.Core(ctx)
	if err != nil {
		return core.Health{}, err
	}
	result := core.Health{Configured: len(saved.AppliedConfig) > 0, Version: Version(), RevisionID: saved.AppliedRevision, PolicyRevision: saved.AppliedPolicy}
	if len(saved.AppliedConfig) > 0 {
		digest := sha256.Sum256(saved.AppliedConfig)
		result.ConfigSHA256 = hex.EncodeToString(digest[:])
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	result.Issue = a.issue
	if a.active != nil {
		result.Configured = true
		result.Running = true
		result.Healthy = true
		result.RuntimeID = a.active.runtimeID
		result.StartedAt = a.active.startedAt
		connections := a.active.tracker.Connections()
		result.Connections = &connections
	} else if a.closing {
		result.Issue = "Proxy configuration is changing"
	}
	return result, nil
}
func (a *Adapter) ReadCounters(ctx context.Context) ([]core.Counter, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	if len(a.pendingFinal) > 0 {
		return append([]core.Counter(nil), a.pendingFinal[0]...), nil
	}
	if a.active == nil {
		return nil, core.ErrNotConfigured
	}
	return a.active.tracker.Counters(), nil
}
func (a *Adapter) ReadLogs(ctx context.Context, maxLines, maxBytes int) (core.LogResult, error) {
	if err := ctx.Err(); err != nil {
		return core.LogResult{}, err
	}
	return a.logs.read(maxLines, maxBytes), nil
}
func (a *Adapter) build(ctx context.Context, raw, authorization []byte) (*instance, error) {
	if err := os.MkdirAll(a.directory, 0700); err != nil {
		return nil, err
	}
	auth, _, _, err := parseAuthorization(authorization)
	if err != nil {
		return nil, err
	}
	config, err := decodeConfig(raw)
	if err != nil {
		return nil, err
	}
	if services, ok := config["services"].([]any); ok && len(services) > 0 {
		return nil, errors.New("embedded core does not expose management services")
	}
	if experimental, ok := config["experimental"].(map[string]any); ok {
		if experimental["v2ray_api"] != nil || experimental["clash_api"] != nil {
			return nil, errors.New("embedded core does not expose external statistics or management APIs")
		}
	}
	lifetime, cancel := context.WithCancel(context.Background())
	coreContext := registryContext(lifetime, a.directory)
	options, err := sj.UnmarshalExtendedContext[option.Options](coreContext, raw)
	if err != nil {
		cancel()
		a.logs.append("Configuration decode failed: " + err.Error())
		return nil, err
	}
	nonce := make([]byte, 16)
	if _, err = rand.Read(nonce); err != nil {
		cancel()
		return nil, err
	}
	runtimeID := "embedded-" + hex.EncodeToString(nonce)

	users := make([]string, 0, len(auth.Users))
	for _, user := range auth.Users {
		users = append(users, user.ID)
	}

	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	engine, err := box.New(box.Options{Context: coreContext, Options: options})
	if err != nil {
		cancel()
		a.logs.append("Configuration initialization failed: " + err.Error())
		return nil, err
	}
	if factory, ok := engine.LogFactory().(log.ObservableFactory); ok {
		factory.AttachPlatformWriter(instanceLogWriter{buffer: &a.logs, level: factory.Level()})
	}
	if err = ctx.Err(); err != nil {
		_ = engine.Close()
		cancel()
		return nil, err
	}
	return &instance{box: engine, cancel: cancel, runtimeID: runtimeID, users: users}, nil
}
func (a *Adapter) start(ctx context.Context, current *instance) error {
	if err := a.retryFinal(ctx); err != nil {
		return err
	}
	current.startedAt = time.Now().UnixMilli()
	current.tracker = NewTracker(current.users, current.runtimeID, current.startedAt)
	current.box.Router().AppendTracker(current.tracker)
	baseline := current.tracker.Counters()
	a.mu.RLock()
	sink := a.finalSample
	a.mu.RUnlock()
	if len(baseline) > 0 {
		if sink == nil {
			return errors.New("traffic persistence callback is not configured")
		}
		if err := sink(ctx, baseline); err != nil {
			return fmt.Errorf("persist runtime zero baseline: %w", err)
		}
	}
	stop := context.AfterFunc(ctx, current.cancel)
	defer stop()
	if err := current.box.Start(); err != nil {
		a.logs.append("Core startup failed: " + err.Error())
		return err
	}
	return ctx.Err()
}
func (a *Adapter) closeInstance(ctx context.Context, current *instance) error {
	if current == nil {
		return nil
	}
	closeErr := current.box.Close()
	current.cancel()
	if errors.Is(closeErr, os.ErrClosed) {
		closeErr = nil
	}
	if current.tracker == nil {
		return closeErr
	}
	drainErr := current.tracker.Drain(ctx)
	if drainErr != nil {
		return errors.Join(closeErr, drainErr)
	}
	sample := current.tracker.Counters()
	for i := range sample {
		sample[i].Final = true
	}
	a.mu.RLock()
	callback := a.finalSample
	a.mu.RUnlock()
	var finalErr error
	if len(sample) > 0 {
		if callback == nil {
			finalErr = errors.New("final traffic sample has no persistence callback")
		} else {
			finalErr = callback(ctx, sample)
		}
	}
	if finalErr != nil {
		a.mu.Lock()
		a.pendingFinal = append(a.pendingFinal, sample)
		issue := "Final traffic sample is pending: " + finalErr.Error()
		a.issue = issue
		a.mu.Unlock()
		a.logs.append(issue)
	}
	if closeErr != nil || finalErr != nil {
		return &closeFailure{lifecycle: closeErr, sample: finalErr}
	}
	return nil
}
func (a *Adapter) detach() *instance {
	a.mu.Lock()
	defer a.mu.Unlock()
	current := a.active
	a.active = nil
	a.closing = true
	return current
}
func (a *Adapter) activate(current *instance) {
	a.mu.Lock()
	a.active = current
	a.closing = false
	if len(a.pendingFinal) == 0 {
		a.issue = ""
	}
	a.mu.Unlock()
}
func (a *Adapter) Close(ctx context.Context) error {
	a.opMu.Lock()
	defer a.opMu.Unlock()
	err := a.closeInstance(ctx, a.detach())
	a.activate(nil)
	retryErr := a.retryFinal(ctx)
	if retryErr == nil {
		var failure *closeFailure
		if errors.As(err, &failure) {
			return failure.lifecycle
		}
	}
	return errors.Join(err, retryErr)
}
func (a *Adapter) Validate(ctx context.Context, raw, authorization []byte) error {
	candidate, err := a.build(ctx, raw, authorization)
	if err != nil {
		return err
	}
	_ = candidate.box.Close()
	candidate.cancel()
	return nil
}
func (a *Adapter) Apply(ctx context.Context, config core.Configuration) (core.Result, error) {
	a.opMu.Lock()
	defer a.opMu.Unlock()
	previous, err := a.store.Core(ctx)
	if err != nil {
		return core.Result{}, err
	}
	_, revision, auth, err := parseAuthorization(config.Authorization)
	if err != nil {
		return core.Result{}, err
	}
	if revision != config.LatestPolicyRevision {
		return core.Result{}, errors.New("authorization revision differs from response")
	}
	if err = a.store.PersistPolicy(ctx, revision, auth); err != nil {
		return core.Result{}, fmt.Errorf("%w: %v", core.ErrStalePolicy, err)
	}
	fail := func(cause error) (core.Result, error) {
		if len(previous.AppliedConfig) > 0 && previous.AppliedPolicy < revision {
			return a.rollback(ctx, previous, cause)
		}
		health, _ := a.Health(ctx)
		return core.Result{Health: health, Rollback: "not_needed"}, cause
	}
	if config.PolicyRevision < revision {
		return fail(core.ErrStalePolicy)
	}
	if config.PolicyRevision != revision {
		return fail(errors.New("configuration policy is unknown"))
	}
	digest := sha256.Sum256(config.JSON)
	if hex.EncodeToString(digest[:]) != config.SHA256 {
		return fail(errors.New("configuration digest mismatch"))
	}
	merged, err := MergeAuthorization(config.JSON, auth)
	if err != nil {
		return fail(err)
	}
	originalObject, err := decodeConfig(config.JSON)
	if err != nil {
		return fail(err)
	}
	mergedObject, err := decodeConfig(merged)
	if err != nil {
		return fail(err)
	}
	originalCanonical, _ := json.Marshal(originalObject)
	mergedCanonical, _ := json.Marshal(mergedObject)
	if !bytes.Equal(originalCanonical, mergedCanonical) {
		return fail(errors.New("configuration users differ from the latest authorization"))
	}
	a.mu.RLock()
	running := a.active != nil
	a.mu.RUnlock()
	if running && previous.AppliedRevision == config.RevisionID && previous.AppliedPolicy == config.PolicyRevision && bytes.Equal(previous.AppliedConfig, config.JSON) {
		health, _ := a.Health(ctx)
		return core.Result{Health: health, Rollback: "not_needed"}, nil
	}
	candidate, err := a.build(ctx, config.JSON, auth)
	if err != nil {
		return fail(err)
	}
	if err = a.store.PrepareCore(ctx, config.TaskID, config.RevisionID, config.PolicyRevision, config.JSON); err != nil {
		_ = candidate.box.Close()
		candidate.cancel()
		return core.Result{}, err
	}
	// opMu prevents replacement while mu is released for the final-sample callback.
	old := a.detach()
	if closeErr := a.closeInstance(ctx, old); closeErr != nil {
		a.logs.append("Previous instance closed with an error: " + closeErr.Error())
	}
	if err = a.start(ctx, candidate); err != nil {
		_ = a.closeInstance(context.WithoutCancel(ctx), candidate)
		return a.rollback(ctx, previous, err)
	}
	a.activate(candidate)
	if err = a.store.CommitCore(ctx, config.RevisionID, config.PolicyRevision, config.JSON); err != nil {
		return a.rollback(ctx, previous, err)
	}
	health, err := a.Health(ctx)
	return core.Result{Health: health, Rollback: "not_needed"}, err
}
func (a *Adapter) rollback(ctx context.Context, previous state.CoreState, cause error) (core.Result, error) {
	recovery, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	_ = a.closeInstance(recovery, a.detach())
	if len(previous.AppliedConfig) == 0 {
		a.activate(nil)
		_ = a.store.AbortCore(recovery)
		a.mu.Lock()
		a.issue = cause.Error()
		a.mu.Unlock()
		return core.Result{Rollback: "not_needed"}, cause
	}
	latest, err := a.store.Core(recovery)
	if err != nil {
		return core.Result{Rollback: "failed"}, errors.Join(cause, err)
	}
	safe, err := MergeAuthorization(previous.AppliedConfig, latest.Authorization)
	if err != nil {
		return core.Result{Rollback: "failed"}, errors.Join(cause, err)
	}
	restored, err := a.build(recovery, safe, latest.Authorization)
	if err == nil {
		err = a.start(recovery, restored)
	}
	if err != nil {
		if restored != nil {
			_ = a.closeInstance(recovery, restored)
		}
		a.activate(nil)
		a.mu.Lock()
		a.issue = err.Error()
		a.mu.Unlock()
		return core.Result{Rollback: "failed"}, fmt.Errorf("apply failed (%v); rollback failed: %w", cause, err)
	}
	a.activate(restored)
	if err = a.store.CommitCore(recovery, previous.AppliedRevision, latest.PolicyFloor, safe); err != nil {
		return core.Result{Rollback: "failed"}, errors.Join(cause, err)
	}
	health, _ := a.Health(recovery)
	return core.Result{Health: health, Rollback: "succeeded"}, cause
}
func (a *Adapter) Recover(ctx context.Context) error {
	a.opMu.Lock()
	defer a.opMu.Unlock()
	saved, err := a.store.Core(ctx)
	if err != nil {
		return err
	}
	if len(saved.AppliedConfig) == 0 {
		if saved.Stage != "idle" {
			return a.store.AbortCore(ctx)
		}
		return nil
	}
	safe := saved.AppliedConfig
	if saved.AppliedPolicy != saved.PolicyFloor || saved.Stage != "idle" {
		safe, err = MergeAuthorization(saved.AppliedConfig, saved.Authorization)
		if err != nil {
			return err
		}
	}
	candidate, err := a.build(ctx, safe, saved.Authorization)
	if err != nil {
		return err
	}
	if err = a.start(ctx, candidate); err != nil {
		_ = a.closeInstance(context.WithoutCancel(ctx), candidate)
		return err
	}
	a.activate(candidate)
	if saved.AppliedPolicy == saved.PolicyFloor && saved.Stage == "idle" {
		return nil
	}
	return a.store.CommitCore(ctx, saved.AppliedRevision, saved.PolicyFloor, safe)
}

func (a *Adapter) retryFinal(ctx context.Context) error {
	for {
		a.mu.RLock()
		if len(a.pendingFinal) == 0 {
			a.mu.RUnlock()
			return nil
		}
		sample := append([]core.Counter(nil), a.pendingFinal[0]...)
		sink := a.finalSample
		a.mu.RUnlock()
		if sink == nil {
			return errors.New("final traffic sample has no persistence callback")
		}
		if err := sink(ctx, sample); err != nil {
			return err
		}
		if len(sample) > 0 {
			a.AcknowledgeFinalSample(sample[0].RuntimeID)
		} else {
			a.mu.Lock()
			a.pendingFinal = a.pendingFinal[1:]
			a.mu.Unlock()
		}
	}
}

type closeFailure struct{ lifecycle, sample error }

func (e *closeFailure) Error() string { return errors.Join(e.lifecycle, e.sample).Error() }
func (e *closeFailure) Unwrap() []error {
	var result []error
	if e.lifecycle != nil {
		result = append(result, e.lifecycle)
	}
	if e.sample != nil {
		result = append(result, e.sample)
	}
	return result
}
