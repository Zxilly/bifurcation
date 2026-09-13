// traffic exercises a real sing-box mixed inbound over TCP and SOCKS5 UDP.
// It is an isolated integration-test helper, not part of either product binary.
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		fail(fmt.Errorf("usage: traffic serve | tcp SOCKS HOST:PORT [PATH] | udp SOCKS HOST:PORT"))
	}
	if os.Args[1] == "serve" {
		fail(serve())
		return
	}
	if len(os.Args) < 4 {
		fail(fmt.Errorf("proxy and target are required"))
	}
	switch os.Args[1] {
	case "tcp":
		path := "/payload"
		if len(os.Args) > 4 {
			path = os.Args[4]
		}
		fail(tcp(os.Args[2], os.Args[3], path))
	case "udp":
		fail(udp(os.Args[2], os.Args[3]))
	default:
		fail(fmt.Errorf("unknown operation"))
	}
}

func fail(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func serve() error {
	packet, err := net.ListenPacket("udp4", ":9090")
	if err != nil {
		return err
	}
	defer packet.Close()
	go func() {
		buffer := make([]byte, 65535)
		for {
			n, address, err := packet.ReadFrom(buffer)
			if err != nil {
				return
			}
			_, _ = packet.WriteTo(buffer[:n], address)
		}
	}()
	mux := http.NewServeMux()
	mux.HandleFunc("/payload", func(w http.ResponseWriter, r *http.Request) {
		body := bytes.Repeat([]byte{0x5a}, 1024*1024)
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = w.Write(body)
	})
	mux.HandleFunc("/stream", func(w http.ResponseWriter, r *http.Request) {
		const chunks = 300
		body := bytes.Repeat([]byte{0x5a}, 8192)
		w.Header().Set("Content-Length", strconv.Itoa(chunks*len(body)))
		for range chunks {
			if _, err := w.Write(body); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
				return
			case <-time.After(100 * time.Millisecond):
			}
		}
	})
	return (&http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 5 * time.Second}).ListenAndServe()
}

func addressBytes(address string) ([]byte, error) {
	host, portString, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	port, err := strconv.ParseUint(portString, 10, 16)
	if err != nil {
		return nil, err
	}
	ip := net.ParseIP(host).To4()
	if ip == nil {
		return nil, fmt.Errorf("integration targets must use IPv4")
	}
	result := append([]byte{1}, ip...)
	return binary.BigEndian.AppendUint16(result, uint16(port)), nil
}

func readAddress(reader io.Reader) (string, error) {
	var kind [1]byte
	if _, err := io.ReadFull(reader, kind[:]); err != nil {
		return "", err
	}
	length := 4
	switch kind[0] {
	case 1:
	case 4:
		length = 16
	default:
		return "", fmt.Errorf("unexpected SOCKS address type %d", kind[0])
	}
	body := make([]byte, length+2)
	if _, err := io.ReadFull(reader, body); err != nil {
		return "", err
	}
	return net.JoinHostPort(net.IP(body[:length]).String(), strconv.Itoa(int(binary.BigEndian.Uint16(body[length:])))), nil
}

func socks(proxy, target string, command byte) (net.Conn, string, error) {
	conn, err := net.DialTimeout("tcp", proxy, 5*time.Second)
	if err != nil {
		return nil, "", err
	}
	failed := true
	defer func() {
		if failed {
			_ = conn.Close()
		}
	}()
	_ = conn.SetDeadline(time.Now().Add(60 * time.Second))
	if _, err = conn.Write([]byte{5, 1, 0}); err != nil {
		return nil, "", err
	}
	var greeting [2]byte
	if _, err = io.ReadFull(conn, greeting[:]); err != nil || greeting != [2]byte{5, 0} {
		return nil, "", fmt.Errorf("SOCKS greeting failed: %v", err)
	}
	address, err := addressBytes(target)
	if err != nil {
		return nil, "", err
	}
	if _, err = conn.Write(append([]byte{5, command, 0}, address...)); err != nil {
		return nil, "", err
	}
	var response [3]byte
	if _, err = io.ReadFull(conn, response[:]); err != nil || response[0] != 5 || response[1] != 0 {
		return nil, "", fmt.Errorf("SOCKS command failed: %v (%v)", response, err)
	}
	bound, err := readAddress(conn)
	if err != nil {
		return nil, "", err
	}
	failed = false
	return conn, bound, nil
}

func tcp(proxy, target, path string) error {
	transport := &http.Transport{DisableKeepAlives: true, DialContext: func(_ context.Context, _, address string) (net.Conn, error) {
		conn, _, err := socks(proxy, address, 1)
		return conn, err
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 60 * time.Second}
	response, err := client.Get("http://" + target + path)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
	if err != nil {
		return err
	}
	expected := 1024 * 1024
	if path == "/stream" {
		expected = 300 * 8192
	}
	if response.StatusCode != 200 || len(body) != expected || !bytes.Equal(body, bytes.Repeat([]byte{0x5a}, expected)) {
		return fmt.Errorf("TCP payload mismatch: status=%d bytes=%d", response.StatusCode, len(body))
	}
	fmt.Printf("TCP verified: %d bytes\n", len(body))
	return nil
}

func udp(proxy, target string) error {
	control, bound, err := socks(proxy, "0.0.0.0:0", 3)
	if err != nil {
		return err
	}
	defer control.Close()
	relay, err := net.ResolveUDPAddr("udp", bound)
	if err != nil {
		return err
	}
	if relay.IP.IsUnspecified() {
		relay.IP = net.ParseIP("127.0.0.1")
	}
	conn, err := net.DialUDP("udp", nil, relay)
	if err != nil {
		return err
	}
	defer conn.Close()
	address, err := addressBytes(target)
	if err != nil {
		return err
	}
	for index := range 10 {
		payload := bytes.Repeat([]byte{byte(index + 1)}, 512)
		packet := append(append([]byte{0, 0, 0}, address...), payload...)
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		if _, err = conn.Write(packet); err != nil {
			return err
		}
		buffer := make([]byte, 2048)
		n, err := conn.Read(buffer)
		if err != nil {
			return err
		}
		if n < 4 || !bytes.Equal(buffer[:3], []byte{0, 0, 0}) {
			return fmt.Errorf("invalid SOCKS UDP response")
		}
		reader := bytes.NewReader(buffer[3:n])
		if _, err = readAddress(reader); err != nil {
			return err
		}
		actual, _ := io.ReadAll(reader)
		if !bytes.Equal(actual, payload) {
			return fmt.Errorf("UDP payload mismatch")
		}
	}
	fmt.Println("UDP verified: 10 datagrams, 512 bytes each")
	return nil
}
