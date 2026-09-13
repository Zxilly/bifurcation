package system

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/Zxilly/bifurcation/services/daemon/internal/core"
)

func TestDaemonArtifactChecksumAndCredentialRedirectBoundary(t *testing.T) {
	data := []byte("verified executable bytes")
	sum := sha256.Sum256(data)
	var targetAuthorization string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		targetAuthorization = r.Header.Get("Authorization")
		_, _ = w.Write(data)
	}))
	defer target.Close()
	sourceAuthorized := false
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sourceAuthorized = r.Header.Get("Authorization") == "Bearer panel-secret"
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer origin.Close()
	artifact := core.Artifact{URL: origin.URL, SHA256: hex.EncodeToString(sum[:]), SizeBytes: int64(len(data))}
	directory := t.TempDir()
	path, err := DownloadBinary(context.Background(), artifact, directory, origin.URL, "panel-secret")
	if err != nil {
		t.Fatal(err)
	}
	if !sourceAuthorized || targetAuthorization != "" {
		t.Fatal("machine token crossed an artifact origin boundary")
	}
	body, err := os.ReadFile(path)
	if err != nil || string(body) != "verified executable bytes" {
		t.Fatal("wrong executable", err)
	}
	artifact.SHA256 = "0000000000000000000000000000000000000000000000000000000000000000"
	if _, err = DownloadBinary(context.Background(), artifact, t.TempDir(), origin.URL, "panel-secret"); err == nil {
		t.Fatal("bad daemon checksum accepted")
	}
}
