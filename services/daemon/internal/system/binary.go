package system

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Zxilly/bifurcation/services/daemon/internal/core"
)

func FileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func CopyAtomic(source, destination string, mode os.FileMode) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	directory := filepath.Dir(destination)
	if err = os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	output, err := os.CreateTemp(directory, ".copy-*")
	if err != nil {
		return err
	}
	defer os.Remove(output.Name())
	if err = output.Chmod(mode); err == nil {
		_, err = io.Copy(output, input)
	}
	if err == nil {
		err = output.Sync()
	}
	closeErr := output.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(output.Name(), destination); err != nil {
		return err
	}
	SyncDirectory(directory)
	return nil
}
func SyncDirectory(directory string) {
	if file, err := os.Open(directory); err == nil {
		_ = file.Sync()
		_ = file.Close()
	}
}

// DownloadBinary verifies a raw daemon artifact without executing any bytes until
// both its manifest length and digest have matched.
func DownloadBinary(ctx context.Context, artifact core.Artifact, directory, panelURL, token string) (string, error) {
	if artifact.SizeBytes <= 0 || artifact.SizeBytes > maxArtifactBytes || len(artifact.SHA256) != 64 {
		return "", errors.New("invalid daemon artifact size or digest")
	}
	if _, err := hex.DecodeString(artifact.SHA256); err != nil {
		return "", err
	}
	target, err := validateDownloadURL(artifact.URL)
	if err != nil {
		return "", err
	}
	panel, _ := url.Parse(panelURL)
	if err = os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(directory, ".download-*")
	if err != nil {
		return "", err
	}
	defer file.Close()
	defer os.Remove(file.Name())
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many artifact redirects")
		}
		if _, err := validateDownloadURL(request.URL.String()); err != nil {
			return err
		}
		if !sameOrigin(request.URL, panel) {
			request.Header.Del("Authorization")
		}
		return nil
	}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return "", err
	}
	if token != "" && sameOrigin(target, panel) {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("daemon download returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength >= 0 && response.ContentLength != artifact.SizeBytes {
		return "", errors.New("daemon artifact length differs from manifest")
	}
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, artifact.SizeBytes+1))
	if err != nil {
		return "", err
	}
	if size != artifact.SizeBytes || !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), artifact.SHA256) {
		return "", errors.New("daemon artifact checksum or size mismatch")
	}
	if err = file.Chmod(0755); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	final := filepath.Join(directory, "candidate")
	if err = os.Rename(file.Name(), final); err != nil {
		return "", err
	}
	SyncDirectory(directory)
	return final, nil
}
