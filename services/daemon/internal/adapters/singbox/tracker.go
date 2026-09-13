package singbox

import (
	"context"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Zxilly/bifurcation/services/daemon/internal/core"
	"github.com/sagernet/sing-box/adapter"
	tun "github.com/sagernet/sing-tun"
	"github.com/sagernet/sing/common"
	"github.com/sagernet/sing/common/buf"
	"github.com/sagernet/sing/common/bufio/deadline"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
)

var _ adapter.ConnectionTracker = (*Tracker)(nil)

type userTraffic struct {
	upload   atomic.Int64
	download atomic.Int64
}

// Tracker belongs to exactly one box runtime. Its user map never changes after
// construction; a configuration switch creates a new runtime and tracker.
type Tracker struct {
	users     map[string]*userTraffic
	userIDs   []string
	runtimeID string
	startedAt int64
	active    atomic.Int64
	mu        sync.Mutex
	draining  bool
	closers   map[trackerCloser]struct{}
	settled   sync.WaitGroup
}

type trackerCloser interface{ Close() error }

func NewTracker(users []string, runtimeID string, startedAt int64) *Tracker {
	t := &Tracker{users: make(map[string]*userTraffic, len(users)), runtimeID: runtimeID, startedAt: startedAt, closers: make(map[trackerCloser]struct{})}
	for _, id := range users {
		if id == "" {
			continue
		}
		if _, exists := t.users[id]; !exists {
			t.users[id] = &userTraffic{}
			t.userIDs = append(t.userIDs, id)
		}
	}
	sort.Strings(t.userIDs)
	return t
}

func (t *Tracker) Counters() []core.Counter {
	result := make([]core.Counter, 0, len(t.userIDs))
	for _, id := range t.userIDs {
		counter := t.users[id]
		result = append(result, core.Counter{UserID: id, RuntimeID: t.runtimeID, StartedAt: t.startedAt, Upload: counter.upload.Load(), Download: counter.download.Load()})
	}
	observedAt := time.Now().UnixMilli()
	for index := range result {
		result[index].ObservedAt = observedAt
	}
	return result
}

func (t *Tracker) Connections() int64 { return t.active.Load() }

func (t *Tracker) register(conn trackerCloser) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.draining {
		return false
	}
	t.closers[conn] = struct{}{}
	t.settled.Add(1)
	t.active.Add(1)
	return true
}

func (t *Tracker) release(conn trackerCloser) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, exists := t.closers[conn]; exists {
		delete(t.closers, conn)
		t.active.Add(-1)
		t.settled.Done()
	}
}

// Drain is called after box.Close. It fences newly routed connections and waits
// until every already-started I/O operation has updated its counters. Closing a
// socket alone is not sufficient: Read may still return n > 0 with its final error.
func (t *Tracker) Drain(ctx context.Context) error {
	t.mu.Lock()
	t.draining = true
	connections := make([]trackerCloser, 0, len(t.closers))
	for conn := range t.closers {
		connections = append(connections, conn)
	}
	t.mu.Unlock()
	for _, conn := range connections {
		go func() { _ = conn.Close() }()
	}
	done := make(chan struct{})
	go func() { t.settled.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type connectionLifetime struct {
	mu        sync.Mutex
	closing   bool
	closed    bool
	inFlight  int
	onSettled func()
	settle    sync.Once
}

func (l *connectionLifetime) begin() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closing {
		return false
	}
	l.inFlight++
	return true
}

func (l *connectionLifetime) end() {
	l.mu.Lock()
	l.inFlight--
	settled := l.closed && l.inFlight == 0
	l.mu.Unlock()
	if settled {
		l.settle.Do(l.onSettled)
	}
}

func (l *connectionLifetime) startClose() {
	l.mu.Lock()
	l.closing = true
	l.mu.Unlock()
}

func (l *connectionLifetime) finishClose() {
	l.mu.Lock()
	l.closed = true
	settled := l.inFlight == 0
	l.mu.Unlock()
	if settled {
		l.settle.Do(l.onSettled)
	}
}

func (t *Tracker) RoutedConnection(_ context.Context, conn net.Conn, metadata adapter.InboundContext, _ adapter.Rule, _ adapter.Outbound) net.Conn {
	traffic := t.users[metadata.User]
	if traffic == nil {
		return conn
	}
	tracked := &trackedConn{inner: conn, traffic: traffic}
	tracked.life.onSettled = func() { t.release(tracked) }
	if !t.register(tracked) {
		_ = tracked.Close()
	}
	return tracked
}

// Deliberately do not expose Upstream/UnwrapReader/Writer: sing's zero-copy
// paths could otherwise finish the connection before an extracted counter
// callback runs. All counted bytes settle inside this wrapper's I/O lifetime.
type trackedConn struct {
	inner     net.Conn
	traffic   *userTraffic
	life      connectionLifetime
	closeOnce sync.Once
	closeErr  error
}

func (c *trackedConn) Read(buffer []byte) (int, error) {
	if !c.life.begin() {
		return 0, net.ErrClosed
	}
	defer c.life.end()
	n, err := c.inner.Read(buffer)
	if n > 0 {
		c.traffic.upload.Add(int64(n))
	}
	return n, err
}

func (c *trackedConn) Write(buffer []byte) (int, error) {
	if !c.life.begin() {
		return 0, net.ErrClosed
	}
	defer c.life.end()
	n, err := c.inner.Write(buffer)
	if n > 0 {
		c.traffic.download.Add(int64(n))
	}
	return n, err
}

func (c *trackedConn) Close() error {
	c.closeOnce.Do(func() {
		c.life.startClose()
		c.closeErr = c.inner.Close()
		c.life.finishClose()
	})
	return c.closeErr
}

func (c *trackedConn) CloseWrite() error {
	if closer, ok := common.Cast[N.WriteCloser](c.inner); ok {
		return closer.CloseWrite()
	}
	return c.Close()
}

func (c *trackedConn) CloseRead() error {
	if closer, ok := common.Cast[N.ReadCloser](c.inner); ok {
		return closer.CloseRead()
	}
	return c.Close()
}

func (c *trackedConn) HandshakeFailure(err error) error {
	if handler, ok := common.Cast[N.HandshakeFailure](c.inner); ok {
		return handler.HandshakeFailure(err)
	}
	return nil
}

func (c *trackedConn) HandshakeSuccess() error {
	if handler, ok := common.Cast[N.HandshakeSuccess](c.inner); ok {
		return handler.HandshakeSuccess()
	}
	return nil
}
func (c *trackedConn) ConnHandshakeSuccess(conn net.Conn) error {
	return N.ReportConnHandshakeSuccess(c.inner, conn)
}
func (c *trackedConn) LocalAddr() net.Addr                { return c.inner.LocalAddr() }
func (c *trackedConn) RemoteAddr() net.Addr               { return c.inner.RemoteAddr() }
func (c *trackedConn) SetDeadline(t time.Time) error      { return c.inner.SetDeadline(t) }
func (c *trackedConn) SetReadDeadline(t time.Time) error  { return c.inner.SetReadDeadline(t) }
func (c *trackedConn) SetWriteDeadline(t time.Time) error { return c.inner.SetWriteDeadline(t) }
func (c *trackedConn) FrontHeadroom() int                 { return N.CalculateFrontHeadroom(c.inner) }
func (c *trackedConn) RearHeadroom() int                  { return N.CalculateRearHeadroom(c.inner) }
func (c *trackedConn) ReaderOverhead() int                { return N.CalculateReaderOverhead(c.inner) }
func (c *trackedConn) ReaderMTU() int                     { return N.CalculateMTU(c.inner, nil) }
func (c *trackedConn) WriterMTU() int                     { return N.CalculateMTU(nil, c.inner) }
func (c *trackedConn) NeedAdditionalReadDeadline() bool {
	return deadline.NeedAdditionalReadDeadline(c.inner)
}

func (t *Tracker) RoutedPacketConnection(_ context.Context, conn N.PacketConn, metadata adapter.InboundContext, _ adapter.Rule, _ adapter.Outbound) N.PacketConn {
	traffic := t.users[metadata.User]
	if traffic == nil {
		return conn
	}
	tracked := &trackedPacketConn{inner: conn, traffic: traffic}
	tracked.life.onSettled = func() { t.release(tracked) }
	if !t.register(tracked) {
		_ = tracked.Close()
	}
	return tracked
}

type trackedPacketConn struct {
	inner     N.PacketConn
	traffic   *userTraffic
	life      connectionLifetime
	closeOnce sync.Once
	closeErr  error
}

func (c *trackedPacketConn) ReadPacket(buffer *buf.Buffer) (M.Socksaddr, error) {
	if !c.life.begin() {
		return M.Socksaddr{}, net.ErrClosed
	}
	defer c.life.end()
	before := buffer.Len()
	destination, err := c.inner.ReadPacket(buffer)
	if read := buffer.Len() - before; read > 0 {
		c.traffic.upload.Add(int64(read))
	}
	return destination, err
}

func (c *trackedPacketConn) WritePacket(buffer *buf.Buffer, destination M.Socksaddr) error {
	if !c.life.begin() {
		buffer.Release()
		return net.ErrClosed
	}
	defer c.life.end()
	size := buffer.Len()
	err := c.inner.WritePacket(buffer, destination)
	if err == nil && size > 0 {
		c.traffic.download.Add(int64(size))
	}
	return err
}

func (c *trackedPacketConn) Close() error {
	c.closeOnce.Do(func() {
		c.life.startClose()
		c.closeErr = c.inner.Close()
		c.life.finishClose()
	})
	return c.closeErr
}
func (c *trackedPacketConn) HandshakeFailure(err error) error {
	if handler, ok := common.Cast[N.HandshakeFailure](c.inner); ok {
		return handler.HandshakeFailure(err)
	}
	return nil
}
func (c *trackedPacketConn) PacketConnHandshakeSuccess(conn net.PacketConn) error {
	return N.ReportPacketConnHandshakeSuccess(c.inner, conn)
}
func (c *trackedPacketConn) LocalAddr() net.Addr                { return c.inner.LocalAddr() }
func (c *trackedPacketConn) SetDeadline(t time.Time) error      { return c.inner.SetDeadline(t) }
func (c *trackedPacketConn) SetReadDeadline(t time.Time) error  { return c.inner.SetReadDeadline(t) }
func (c *trackedPacketConn) SetWriteDeadline(t time.Time) error { return c.inner.SetWriteDeadline(t) }

// Packet copy allocates protocol header/trailer room before calling WritePacket.
// Forward these layout requirements without exposing an I/O-unwrapping path.
func (c *trackedPacketConn) FrontHeadroom() int  { return N.CalculateFrontHeadroom(c.inner) }
func (c *trackedPacketConn) RearHeadroom() int   { return N.CalculateRearHeadroom(c.inner) }
func (c *trackedPacketConn) ReaderOverhead() int { return N.CalculateReaderOverhead(c.inner) }
func (c *trackedPacketConn) ReaderMTU() int      { return N.CalculateMTU(c.inner, nil) }
func (c *trackedPacketConn) WriterMTU() int      { return N.CalculateMTU(nil, c.inner) }
func (c *trackedPacketConn) NeedAdditionalReadDeadline() bool {
	return deadline.NeedAdditionalReadDeadline(c.inner)
}

func (t *Tracker) RoutedFlow(_ context.Context, metadata adapter.InboundContext, _ adapter.Rule, _ adapter.Outbound) tun.FlowTracker {
	traffic := t.users[metadata.User]
	if traffic == nil {
		return nil
	}
	flow := &trackedFlow{tracker: t, traffic: traffic}
	if !t.register(flow) {
		_ = flow.Close()
	}
	return flow
}

type trackedFlow struct {
	tracker *Tracker
	traffic *userTraffic
	mu      sync.Mutex
	handle  tun.FlowHandle
	closed  bool
	once    sync.Once
}

func (f *trackedFlow) AttachFlow(handle tun.FlowHandle) {
	f.mu.Lock()
	f.handle = handle
	closed := f.closed
	f.mu.Unlock()
	if closed {
		handle.CloseFlow()
	}
}
func (f *trackedFlow) CountForward(n int) {
	if n > 0 {
		f.traffic.upload.Add(int64(n))
	}
}
func (f *trackedFlow) CountReverse(n int) {
	if n > 0 {
		f.traffic.download.Add(int64(n))
	}
}
func (f *trackedFlow) FlowEstablished() {}
func (f *trackedFlow) CloseFlow(_ tun.FlowCloseReason) {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	f.once.Do(func() { f.tracker.release(f) })
}
func (f *trackedFlow) Close() error {
	f.mu.Lock()
	handle := f.handle
	f.closed = true
	f.mu.Unlock()
	if handle != nil {
		handle.CloseFlow()
	}
	f.CloseFlow(tun.FlowCloseReset)
	return nil
}
