package system

import (
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const maxArtifactBytes int64 = 256 << 20

func validateDownloadURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Host == "" || u.User != nil || u.Fragment != "" {
		return nil, errors.New("invalid artifact URL")
	}
	ip := net.ParseIP(u.Hostname())
	loopback := u.Hostname() == "localhost" || ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return nil, errors.New("artifact URL requires HTTPS")
	}
	return u, nil
}
func sameOrigin(a, b *url.URL) bool {
	if a == nil || b == nil || !strings.EqualFold(a.Scheme, b.Scheme) || !strings.EqualFold(a.Hostname(), b.Hostname()) {
		return false
	}
	port := func(u *url.URL) string {
		if u.Port() != "" {
			return u.Port()
		}
		if u.Scheme == "https" {
			return "443"
		}
		return "80"
	}
	return port(a) == port(b)
}

func AtomicWrite(path string, data []byte, mode os.FileMode) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(directory, ".replace-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	// Directory fsync makes rename durable on Linux; unsupported filesystems may reject it.
	if directoryFile, e := os.Open(directory); e == nil {
		_ = directoryFile.Sync()
		_ = directoryFile.Close()
	}
	return nil
}
