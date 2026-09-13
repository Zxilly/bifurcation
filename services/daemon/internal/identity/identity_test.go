package identity

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIdentityAndBindingPersist(t *testing.T) {
	dir := t.TempDir()
	a, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = SaveBinding(dir, &a, 7); err != nil {
		t.Fatal(err)
	}
	b, err := Load(dir)
	if err != nil || b != a {
		t.Fatalf("%+v %+v %v", a, b, err)
	}
	if err = SaveBinding(dir, &b, 8); err == nil {
		t.Fatal("implicit rebinding allowed")
	}
}
func TestConfigRejectsInsecureNonLoopback(t *testing.T) {
	p := filepath.Join(t.TempDir(), "daemon.json")
	if err := os.WriteFile(p, []byte(`{"panelUrl":"http://example.org","token":"secret","stateDirectory":"state"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(p); err == nil {
		t.Fatal("insecure config accepted")
	}
}

func TestConfigureValidatesBeforeReplacingExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	original := Config{PanelURL: "http://127.0.0.1:3499", Token: "secret", StateDirectory: t.TempDir()}
	if err := WriteConfig(path, original, false); err != nil {
		t.Fatal(err)
	}
	invalid := original
	invalid.PanelURL = "http://public.example.org"
	if err := WriteConfig(path, invalid, false); err == nil {
		t.Fatal("insecure replacement accepted")
	}
	loaded, err := LoadConfig(path)
	if err != nil || loaded != original {
		t.Fatalf("original config changed: %+v %v", loaded, err)
	}
}

func TestConfigureRequiresExplicitReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	original := Config{PanelURL: "http://localhost:3499", Token: "old", StateDirectory: t.TempDir()}
	if err := WriteConfig(path, original, false); err != nil {
		t.Fatal(err)
	}
	if err := WriteConfig(path, original, false); err != nil {
		t.Fatal("same configuration was not idempotent", err)
	}
	changed := original
	changed.Token = "new"
	if err := WriteConfig(path, changed, false); err == nil {
		t.Fatal("conflicting token replaced without explicit takeover")
	}
	loaded, err := LoadConfig(path)
	if err != nil || loaded.Token != "old" {
		t.Fatal("old token lost")
	}
	if err = WriteConfig(path, changed, true); err != nil {
		t.Fatal(err)
	}
	loaded, err = LoadConfig(path)
	if err != nil || loaded.Token != "new" {
		t.Fatal("explicit replacement failed")
	}
}

func TestConfigureNeverReusesInstallationAcrossPanelsOrStateDirectories(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	original := Config{PanelURL: "http://localhost:3499", Token: "old", StateDirectory: t.TempDir()}
	if err := WriteConfig(path, original, false); err != nil {
		t.Fatal(err)
	}
	id, err := Load(original.StateDirectory)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []Config{
		{PanelURL: "http://localhost:3500", Token: "new", StateDirectory: original.StateDirectory},
		{PanelURL: original.PanelURL, Token: "new", StateDirectory: t.TempDir()},
	} {
		if err := WriteConfig(path, change, true); err == nil {
			t.Fatal("unsafe installation replacement accepted")
		}
		loaded, err := LoadConfig(path)
		if err != nil || loaded != original {
			t.Fatalf("original configuration changed: %+v %v", loaded, err)
		}
		saved, err := Load(original.StateDirectory)
		if err != nil || saved != id {
			t.Fatal("original installation identity changed")
		}
	}
}
