package singbox

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/transport/trojan"
	tun "github.com/sagernet/sing-tun"
	"github.com/sagernet/sing/common/buf"
	B "github.com/sagernet/sing/common/bufio"
	"github.com/sagernet/sing/common/bufio/deadline"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
)

func drainTracker(t *testing.T, tracker *Tracker) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := tracker.Drain(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestTrackerTCPCountsCopyPathsAndHalfClose(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	_ = server.SetDeadline(time.Now().Add(3 * time.Second))
	tracker := NewTracker([]string{"zero-user", "member", "member"}, "runtime-one", 1234)
	tracked := tracker.RoutedConnection(context.Background(), server, adapter.InboundContext{User: "member"}, nil, nil)
	if tracker.Connections() != 1 {
		t.Fatal("connection not registered")
	}
	upload := bytes.Repeat([]byte("upload"), 4096)
	download := bytes.Repeat([]byte("download"), 4096)
	clientDone := make(chan error, 1)
	go func() {
		if _, writeErr := client.Write(upload); writeErr != nil {
			clientDone <- writeErr
			return
		}
		if closeErr := client.(*net.TCPConn).CloseWrite(); closeErr != nil {
			clientDone <- closeErr
			return
		}
		actual, readErr := io.ReadAll(client)
		if readErr == nil && !bytes.Equal(actual, download) {
			readErr = errors.New("download changed")
		}
		clientDone <- readErr
	}()
	var received bytes.Buffer
	if n, copyErr := B.Copy(&received, tracked); copyErr != nil || n != int64(len(upload)) || !bytes.Equal(received.Bytes(), upload) {
		t.Fatalf("upload copy: bytes=%d error=%v", n, copyErr)
	}
	if n, copyErr := B.Copy(tracked, bytes.NewReader(download)); copyErr != nil || n != int64(len(download)) {
		t.Fatalf("download copy: bytes=%d error=%v", n, copyErr)
	}
	if err = tracked.(interface{ CloseWrite() error }).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	if err = <-clientDone; err != nil {
		t.Fatal(err)
	}
	_ = tracked.Close()
	_ = tracked.Close()
	drainTracker(t, tracker)
	if tracker.Connections() != 0 {
		t.Fatal("closed connection retained")
	}
	counters := tracker.Counters()
	if len(counters) != 2 || counters[0].UserID != "member" || counters[0].Upload != int64(len(upload)) || counters[0].Download != int64(len(download)) {
		t.Fatalf("wrong TCP counters: %+v", counters)
	}
	if counters[0].RuntimeID != "runtime-one" || counters[0].StartedAt != 1234 || counters[0].ObservedAt <= 0 || counters[1].Upload != 0 || counters[1].Download != 0 {
		t.Fatalf("wrong counter metadata or zero user: %+v", counters)
	}
}

func TestTrackerUDPPayloads(t *testing.T) {
	server, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_ = server.SetDeadline(time.Now().Add(3 * time.Second))
	_ = client.SetDeadline(time.Now().Add(3 * time.Second))
	tracker := NewTracker([]string{"member"}, "udp-runtime", 2000)
	tracked := tracker.RoutedPacketConnection(context.Background(), B.NewPacketConn(server), adapter.InboundContext{User: "member"}, nil, nil)
	upload, download := []byte("actual UDP upload"), []byte("actual UDP response")
	if _, err = client.WriteTo(upload, server.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	packet := buf.NewPacket()
	peer, err := tracked.ReadPacket(packet)
	if err != nil || !bytes.Equal(packet.Bytes(), upload) {
		t.Fatalf("UDP read: %v", err)
	}
	packet.Release()
	if err = tracked.WritePacket(buf.As(download), peer); err != nil {
		t.Fatal(err)
	}
	received := make([]byte, 1024)
	n, _, err := client.ReadFrom(received)
	if err != nil || !bytes.Equal(received[:n], download) {
		t.Fatalf("UDP response: %v", err)
	}
	drainTracker(t, tracker)
	counter := tracker.Counters()[0]
	if counter.Upload != int64(len(upload)) || counter.Download != int64(len(download)) || tracker.Connections() != 0 {
		t.Fatalf("wrong UDP counters: %+v", counter)
	}
	if err = tracked.WritePacket(buf.As([]byte("closed")), M.SocksaddrFromNet(client.LocalAddr())); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("write after drain: %v", err)
	}
}

type delayedReadConn struct {
	net.Conn
	readReturned chan struct{}
	releaseRead  chan struct{}
	closed       chan struct{}
	closeOnce    sync.Once
}

func (c *delayedReadConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		close(c.readReturned)
		<-c.releaseRead
		return n, io.EOF // A valid Reader may return final bytes and EOF together.
	}
	return n, err
}
func (c *delayedReadConn) Close() error {
	err := c.Conn.Close()
	c.closeOnce.Do(func() { close(c.closed) })
	return err
}

func TestTrackerDrainWaitsForFinalReadBytes(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	delayed := &delayedReadConn{Conn: server, readReturned: make(chan struct{}), releaseRead: make(chan struct{}), closed: make(chan struct{})}
	tracker := NewTracker([]string{"member"}, "tail-runtime", 3000)
	tracked := tracker.RoutedConnection(context.Background(), delayed, adapter.InboundContext{User: "member"}, nil, nil)
	payload := []byte("bytes already received while Close races with Read")
	readDone := make(chan error, 1)
	go func() {
		data := make([]byte, 1024)
		n, err := tracked.Read(data)
		if n != len(payload) || !bytes.Equal(data[:n], payload) || !errors.Is(err, io.EOF) {
			readDone <- errors.New("final read lost data")
			return
		}
		readDone <- nil
	}()
	if _, err := client.Write(payload); err != nil {
		t.Fatal(err)
	}
	<-delayed.readReturned
	ctx, cancel := context.WithCancel(context.Background())
	drainDone := make(chan error, 1)
	go func() { drainDone <- tracker.Drain(ctx) }()
	<-delayed.closed
	select {
	case err := <-drainDone:
		t.Fatalf("Drain completed before the final read settled: %v", err)
	default:
	}
	cancel()
	if err := <-drainDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("Drain ignored cancellation: %v", err)
	}
	close(delayed.releaseRead)
	if err := <-readDone; err != nil {
		t.Fatal(err)
	}
	drainTracker(t, tracker)
	if counter := tracker.Counters()[0]; counter.Upload != int64(len(payload)) {
		t.Fatalf("final bytes lost: %+v", counter)
	}
}

type delayedWriteConn struct {
	net.Conn
	written chan struct{}
	release chan struct{}
	closed  chan struct{}
	once    sync.Once
}

func (c *delayedWriteConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p[:4])
	close(c.written)
	<-c.release
	if err == nil {
		err = io.ErrClosedPipe
	}
	return n, err
}

func (c *delayedWriteConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { close(c.closed) })
	return err
}

func TestTrackerDrainCountsOnlyAcceptedPartialWriteBytes(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	delayed := &delayedWriteConn{Conn: server, written: make(chan struct{}), release: make(chan struct{}), closed: make(chan struct{})}
	tracker := NewTracker([]string{"member"}, "write-tail", 3500)
	tracked := tracker.RoutedConnection(context.Background(), delayed, adapter.InboundContext{User: "member"}, nil, nil)
	written := make(chan error, 1)
	go func() {
		n, err := tracked.Write([]byte("accepted and rejected"))
		if n != 4 || !errors.Is(err, io.ErrClosedPipe) {
			written <- errors.New("partial write result changed")
			return
		}
		written <- nil
	}()
	actual := make([]byte, 4)
	if _, err := io.ReadFull(client, actual); err != nil || string(actual) != "acce" {
		t.Fatalf("partial wire bytes: %q, %v", actual, err)
	}
	<-delayed.written
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	drained := make(chan error, 1)
	go func() { drained <- tracker.Drain(ctx) }()
	<-delayed.closed
	select {
	case err := <-drained:
		t.Fatalf("Drain ignored pending partial write: %v", err)
	default:
	}
	close(delayed.release)
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := <-drained; err != nil {
		t.Fatal(err)
	}
	if counter := tracker.Counters()[0]; counter.Download != 4 {
		t.Fatalf("partial accepted bytes were lost or overcounted: %+v", counter)
	}
}

func TestTrackerUnknownUserIsNotAttributed(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	tracker := NewTracker([]string{"member"}, "runtime", 1)
	conn := tracker.RoutedConnection(context.Background(), server, adapter.InboundContext{User: "unknown"}, nil, nil)
	written := make(chan error, 1)
	go func() { _, err := client.Write([]byte("unattributed")); written <- err }()
	if _, err := io.ReadFull(conn, make([]byte, len("unattributed"))); err != nil {
		t.Fatal(err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if conn != server || tracker.Connections() != 0 || tracker.Counters()[0].Upload != 0 {
		t.Fatal("unknown user was attributed to a configured account")
	}
	if tracker.RoutedFlow(context.Background(), adapter.InboundContext{User: "unknown"}, nil, nil) != nil {
		t.Fatal("unknown flow was attributed")
	}
	drainTracker(t, tracker)
}

type testFlowHandle struct {
	conn   net.Conn
	flow   tun.FlowTracker
	closed bool
}

func (h *testFlowHandle) CloseFlow() {
	h.closed = true
	_ = h.conn.Close()
	h.flow.CloseFlow(tun.FlowCloseFinished)
}

func TestTrackerFlowCallbacksFromActualIO(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	tracker := NewTracker([]string{"member"}, "flow-runtime", 4000)
	flow := tracker.RoutedFlow(context.Background(), adapter.InboundContext{User: "member"}, nil, nil)
	handle := &testFlowHandle{conn: server, flow: flow}
	flow.AttachFlow(handle)
	upload, download := []byte("forwarded flow bytes"), []byte("reverse flow bytes")
	done := make(chan error, 1)
	go func() {
		n, err := io.ReadFull(server, make([]byte, len(upload)))
		flow.CountForward(n)
		if err == nil {
			flow.FlowEstablished()
			n, err = server.Write(download)
			flow.CountReverse(n)
		}
		done <- err
	}()
	if _, err := client.Write(upload); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(client, make([]byte, len(download))); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	drainTracker(t, tracker)
	flow.CloseFlow(tun.FlowCloseFinished)
	if !handle.closed || tracker.Connections() != 0 {
		t.Fatal("flow handle was not drained")
	}
	counter := tracker.Counters()[0]
	if counter.Upload != int64(len(upload)) || counter.Download != int64(len(download)) {
		t.Fatalf("wrong flow counters: %+v", counter)
	}
}

type onePacketReader struct {
	reader N.PacketReader
	read   bool
}

func (r *onePacketReader) ReadPacket(buffer *buf.Buffer) (M.Socksaddr, error) {
	if r.read {
		return M.Socksaddr{}, io.EOF
	}
	r.read = true
	return r.reader.ReadPacket(buffer)
}

func TestTrackerTrojanPacketCopyPreservesHeadroom(t *testing.T) {
	udp, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	sender, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	_ = udp.SetDeadline(time.Now().Add(3 * time.Second))
	peer, transport := net.Pipe()
	defer peer.Close()
	defer transport.Close()
	_ = peer.SetDeadline(time.Now().Add(3 * time.Second))
	_ = transport.SetDeadline(time.Now().Add(3 * time.Second))
	tracker := NewTracker([]string{"member"}, "trojan-packet", 2500)
	protocol := &trojan.PacketConn{Conn: transport}
	tracked := tracker.RoutedPacketConnection(context.Background(), protocol, adapter.InboundContext{User: "member"}, nil, nil)
	if room := N.CalculateFrontHeadroom(tracked); room == 0 || room != N.CalculateFrontHeadroom(protocol) {
		t.Fatalf("Trojan headroom was hidden: %d", room)
	}
	if !deadline.NeedAdditionalReadDeadline(tracked) {
		t.Fatal("Trojan read-deadline requirement was hidden")
	}
	payload := []byte("UDP response copied into a real Trojan frame")
	if _, err = sender.WriteTo(payload, udp.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	copied := make(chan error, 1)
	go func() {
		n, copyErr := B.CopyPacket(tracked, &onePacketReader{reader: B.NewPacketConn(udp)})
		if n != int64(len(payload)) || (copyErr != nil && !errors.Is(copyErr, io.EOF)) {
			copied <- errors.New("Trojan packet copy failed")
			return
		}
		copied <- nil
	}()
	packet := buf.NewPacket()
	destination, err := trojan.ReadPacket(peer, packet)
	if err != nil || !bytes.Equal(packet.Bytes(), payload) || destination != M.SocksaddrFromNet(sender.LocalAddr()) {
		t.Fatalf("Trojan frame was changed: destination=%v error=%v", destination, err)
	}
	packet.Release()
	if err = <-copied; err != nil {
		t.Fatal(err)
	}
	drainTracker(t, tracker)
	if traffic := tracker.Counters()[0]; traffic.Download != int64(len(payload)) || traffic.Upload != 0 {
		t.Fatalf("protocol header was billed as payload: %+v", traffic)
	}
}
