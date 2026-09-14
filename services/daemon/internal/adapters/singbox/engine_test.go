//go:build with_quic

package singbox

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"path/filepath"
	"testing"
	"time"

	v1 "github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1"
	"github.com/Zxilly/bifurcation/services/daemon/internal/core"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	box "github.com/sagernet/sing-box"
	sbadapter "github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/adapter/outbound"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing-box/protocol/hysteria2"
	"github.com/sagernet/sing-box/protocol/trojan"
	sj "github.com/sagernet/sing/common/json"
	M "github.com/sagernet/sing/common/metadata"
	"github.com/sagernet/sing/service"
	"google.golang.org/protobuf/proto"
)

func embeddedCertificate(t *testing.T) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	var pub any
	if err == nil {
		pub = &key.PublicKey
	}
	if err != nil {
		t.Fatal(err)
	}
	certificate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"}, DNSNames: []string{"localhost"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true, IsCA: true}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}))
}
func embeddedPorts(t *testing.T) (int, int) {
	t.Helper()
	tcp, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	udp, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		tcp.Close()
		t.Fatal(err)
	}
	tp, up := tcp.Addr().(*net.TCPAddr).Port, udp.LocalAddr().(*net.UDPAddr).Port
	tcp.Close()
	udp.Close()
	return tp, up
}
func embeddedConfig(t *testing.T, auth []byte) ([]byte, string, int, int) {
	t.Helper()
	cert, key := embeddedCertificate(t)
	tcpPort, udpPort := embeddedPorts(t)
	data := map[string]any{"log": map[string]any{"level": "info", "disabled": false}, "inbounds": []any{map[string]any{"type": "trojan", "tag": "bifurcation-trojan", "listen": "127.0.0.1", "listen_port": tcpPort, "users": []any{}, "tls": map[string]any{"enabled": true, "certificate": []string{cert}, "key": []string{key}}}, map[string]any{"type": "hysteria2", "tag": "bifurcation-hysteria2", "listen": "127.0.0.1", "listen_port": udpPort, "users": []any{}, "tls": map[string]any{"enabled": true, "certificate": []string{cert}, "key": []string{key}}}}, "outbounds": []any{map[string]any{"type": "direct", "tag": "direct"}}, "route": map[string]any{"final": "direct"}}
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	raw, err = MergeAuthorization(raw, auth)
	if err != nil {
		t.Fatal(err)
	}
	return raw, cert, tcpPort, udpPort
}
func embeddedRequest(id string, policy int64, raw, auth []byte) core.Configuration {
	sum := sha256.Sum256(raw)
	return core.Configuration{TaskID: id, RevisionID: id, PolicyRevision: policy, JSON: raw, SHA256: hex.EncodeToString(sum[:]), Authorization: auth, LatestPolicyRevision: policy}
}
func embeddedSink(store *state.Store) func(context.Context, []core.Counter) error {
	return func(ctx context.Context, counters []core.Counter) error {
		sample := make([]state.Counter, 0, len(counters))
		for _, counter := range counters {
			sample = append(sample, state.Counter{UserID: counter.UserID, RuntimeID: counter.RuntimeID, StartedAt: counter.StartedAt, ObservedAt: counter.ObservedAt, Upload: counter.Upload, Download: counter.Download, Final: counter.Final})
		}
		if len(sample) == 0 {
			return nil
		}
		_, err := store.RecordSample(ctx, "embedded-test-stream", sample)
		return err
	}
}
func embeddedClient(t *testing.T, protocol, password, cert string, port int) sbadapter.Outbound {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	ctx = registryContext(ctx, t.TempDir())
	registry := service.FromContext[sbadapter.OutboundRegistry](ctx).(*outbound.Registry)
	trojan.RegisterOutbound(registry)
	hysteria2.RegisterOutbound(registry)
	raw, err := json.Marshal(map[string]any{"log": map[string]any{"disabled": true}, "outbounds": []any{map[string]any{"type": protocol, "tag": "proxy", "server": "127.0.0.1", "server_port": port, "password": password, "tls": map[string]any{"enabled": true, "server_name": "localhost", "certificate": []string{cert}}}}})
	if err != nil {
		t.Fatal(err)
	}
	opts, err := sj.UnmarshalExtendedContext[option.Options](ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	client, err := box.New(box.Options{Context: ctx, Options: opts})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if err = client.Start(); err != nil {
		client.Close()
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close(); cancel() })
	result, ok := client.Outbound().Outbound("proxy")
	if !ok {
		t.Fatal("proxy outbound missing")
	}
	return result
}
func echoEndpoints(t *testing.T) (net.Listener, net.PacketConn) {
	t.Helper()
	tcp, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	udp, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		tcp.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { tcp.Close(); udp.Close() })
	go func() {
		for {
			conn, err := tcp.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	go func() {
		buffer := make([]byte, 65535)
		for {
			size, peer, err := udp.ReadFrom(buffer)
			if err != nil {
				return
			}
			_, _ = udp.WriteTo(buffer[:size], peer)
		}
	}()
	return tcp, udp
}
func TestEmbeddedTCPUDPAndFinalAccounting(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	directory := t.TempDir()
	store, err := state.Open(ctx, filepath.Join(directory, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	engine := New(store, directory)
	engine.SetFinalSample(embeddedSink(store))
	defer engine.Close(context.Background())
	auth := []byte(`{"version":1,"policyRevision":"1","users":[{"id":"user-a","trojanPassword":"a-t","hysteria2Password":"a-h"},{"id":"user-b","trojanPassword":"b-t","hysteria2Password":"b-h"}]}`)
	raw, cert, tcpPort, udpPort := embeddedConfig(t, auth)
	request := embeddedRequest("initial", 1, raw, auth)
	result, err := engine.Apply(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Health.Healthy || result.Health.Version != "1.14.0" || result.Health.ConfigSHA256 != request.SHA256 {
		t.Fatalf("incorrect library status: %+v", result)
	}
	tcp, udp := echoEndpoints(t)
	expected := make(map[string]int64)
	for _, user := range []string{"a", "b"} {
		for _, protocol := range []string{"trojan", "hysteria2"} {
			port, password := tcpPort, user+"-t"
			if protocol == "hysteria2" {
				port = udpPort
				password = user + "-h"
			}
			client := embeddedClient(t, protocol, password, cert, port)
			connection, err := client.DialContext(ctx, "tcp", M.ParseSocksaddr(tcp.Addr().String()))
			// The initial default-interface notification can reset Hysteria2's
			// QUIC handshake after Start returns (especially on Windows). Retry
			// only that pre-payload failure; never replay accounted test traffic.
			for attempt := 0; err != nil && err.Error() == "network changed" && attempt < 3; attempt++ {
				connection, err = client.DialContext(ctx, "tcp", M.ParseSocksaddr(tcp.Addr().String()))
			}
			if err != nil {
				t.Fatal(err)
			}
			connection.SetDeadline(time.Now().Add(5 * time.Second))
			payload := bytes.Repeat([]byte("t"), 4096)
			if _, err = connection.Write(payload); err != nil {
				t.Fatal(err)
			}
			response := make([]byte, len(payload))
			if _, err = io.ReadFull(connection, response); err != nil || !bytes.Equal(response, payload) {
				t.Fatal("TCP echo failed", err)
			}
			connection.Close()
			packet, err := client.ListenPacket(ctx, M.ParseSocksaddr(udp.LocalAddr().String()))
			if err != nil {
				t.Fatal(err)
			}
			packet.SetDeadline(time.Now().Add(5 * time.Second))
			payload = bytes.Repeat([]byte("u"), 333)
			if _, err = packet.WriteTo(payload, udp.LocalAddr()); err != nil {
				t.Fatal(err)
			}
			response = make([]byte, 1024)
			size, _, err := packet.ReadFrom(response)
			if err != nil || !bytes.Equal(response[:size], payload) {
				t.Fatal("UDP echo failed", err)
			}
			packet.Close()
			expected["user-"+user] += 4096 + 333
		}
	}
	if err = engine.Close(ctx); err != nil {
		t.Fatal(err)
	}
	cursors, err := store.UsageQueue(ctx, "embedded-test-stream")
	if err != nil || cursors.PendingBatches == 0 {
		t.Fatal("final traffic was not persisted", err)
	}
	totals := map[string]int64{}
	for {
		batch, err := store.NextBatch(ctx, "embedded-test-stream")
		if err != nil {
			t.Fatal(err)
		}
		if batch == nil {
			break
		}
		var message v1.UsageBatch
		if err = proto.Unmarshal(batch.Payload, &message); err != nil {
			t.Fatal(err)
		}
		for _, delta := range message.Deltas {
			if delta.Incomplete {
				t.Fatal("graceful close was marked as a crash gap")
			}
			if delta.UploadBytes != delta.DownloadBytes {
				t.Fatalf("asymmetric echo accounting %+v", delta)
			}
			totals[delta.UserId] += delta.UploadBytes
		}
		if err = store.AcknowledgeUsage(ctx, "embedded-test-stream", batch.Seq); err != nil {
			t.Fatal(err)
		}
	}
	for user, want := range expected {
		if totals[user] != want {
			t.Fatalf("%s counted %d, want %d", user, totals[user], want)
		}
	}
	logs, err := engine.ReadLogs(ctx, 100, 65536)
	if err != nil || logs.Source != "embedded-core" || len(logs.Lines) == 0 {
		t.Fatal("embedded log capture missing", err)
	}
}
func TestEmbeddedStartupFailureRollsBackLatestAuthorization(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	directory := t.TempDir()
	store, err := state.Open(ctx, filepath.Join(directory, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	engine := New(store, directory)
	engine.SetFinalSample(embeddedSink(store))
	defer engine.Close(context.Background())
	auth := []byte(`{"version":1,"policyRevision":"1","users":[{"id":"user","trojanPassword":"old","hysteria2Password":"old"}]}`)
	raw, _, _, _ := embeddedConfig(t, auth)
	if _, err = engine.Apply(ctx, embeddedRequest("initial", 1, raw, auth)); err != nil {
		t.Fatal(err)
	}
	denied := []byte(`{"version":1,"policyRevision":"2","users":[]}`)
	bad, err := MergeAuthorization(raw, denied)
	if err != nil {
		t.Fatal(err)
	}
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	var object map[string]any
	json.Unmarshal(bad, &object)
	object["inbounds"].([]any)[0].(map[string]any)["listen_port"] = occupied.Addr().(*net.TCPAddr).Port
	bad, _ = json.Marshal(object)
	result, err := engine.Apply(ctx, embeddedRequest("bad", 2, bad, denied))
	if err == nil || result.Rollback != "succeeded" || !result.Health.Healthy {
		t.Fatalf("bad startup was not safely rolled back: %+v %v", result, err)
	}
	saved, err := store.Core(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(saved.AppliedConfig, []byte(`"password":"old"`)) || saved.AppliedPolicy != 2 || saved.AppliedRevision != "initial" {
		t.Fatal("rollback restored revoked credentials")
	}
	stale := embeddedRequest("stale", 1, raw, denied)
	stale.LatestPolicyRevision = 2
	if _, err = engine.Apply(ctx, stale); !errors.Is(err, core.ErrStalePolicy) {
		t.Fatal("stale policy was accepted", err)
	}
	if err = engine.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err = engine.Recover(ctx); err != nil {
		t.Fatal("approved configuration did not recover", err)
	}
}

func TestEmbeddedFinalSampleCanRetryWithoutLosingCleanClose(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	directory := t.TempDir()
	store, err := state.Open(ctx, filepath.Join(directory, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	engine := New(store, directory)
	logs, err := engine.ReadLogs(ctx, 100, 4096)
	if err != nil || logs.Source != "embedded-core" || len(logs.Lines) != 0 {
		t.Fatal("unconfigured core cannot return empty logs", err)
	}
	auth := []byte(`{"version":1,"policyRevision":"1","users":[{"id":"user","trojanPassword":"t","hysteria2Password":"h"}]}`)
	raw, _, _, _ := embeddedConfig(t, auth)
	sink := embeddedSink(store)
	failed := false
	engine.SetFinalSample(func(ctx context.Context, counters []core.Counter) error {
		// Read-only adapter methods are safe from the sink: instance replacement is
		// serialized separately and no adapter read lock is held here.
		if _, err := engine.Health(ctx); err != nil {
			return err
		}
		if len(counters) > 0 && counters[0].Final && !failed {
			failed = true
			return errors.New("temporary persistence failure")
		}
		return sink(ctx, counters)
	})
	if _, err = engine.Apply(ctx, embeddedRequest("initial", 1, raw, auth)); err != nil {
		t.Fatal(err)
	}
	if err = engine.Close(ctx); err != nil {
		t.Fatal("successful final retry was reported as a dirty shutdown", err)
	}
	if !failed {
		t.Fatal("final persistence failure was not exercised")
	}
	engine.mu.RLock()
	pending := len(engine.pendingFinal)
	engine.mu.RUnlock()
	if pending != 0 {
		t.Fatal("acknowledged final snapshot was retained")
	}
}
