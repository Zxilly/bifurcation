package identity

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type Identity struct {
	InstallationID string `json:"installationId"`
	BindingEpoch   int64  `json:"bindingEpoch"`
}
type Config struct {
	PanelURL       string `json:"panelUrl"`
	Token          string `json:"token"`
	StateDirectory string `json:"stateDirectory"`
}

func LoadConfig(path string) (Config, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err = json.Unmarshal(body, &c); err != nil {
		return c, err
	}
	u, err := url.Parse(c.PanelURL)
	if err != nil {
		return c, err
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Host == "" {
		return c, errors.New("invalid panel URL")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return c, errors.New("panel URL requires HTTPS except loopback")
	}
	c.PanelURL = strings.TrimRight(c.PanelURL, "/")
	if strings.TrimSpace(c.Token) == "" || strings.ContainsAny(c.Token, "\r\n") || c.StateDirectory == "" {
		return c, errors.New("token and stateDirectory are required")
	}
	return c, nil
}
func Load(directory string) (Identity, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return Identity{}, err
	}
	path := filepath.Join(directory, "identity.json")
	body, err := os.ReadFile(path)
	if err == nil {
		var i Identity
		if err = json.Unmarshal(body, &i); err != nil {
			return i, err
		}
		if i.InstallationID == "" || i.BindingEpoch < 0 {
			return i, errors.New("invalid persisted identity")
		}
		return i, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Identity{}, err
	}
	b := make([]byte, 24)
	if _, err = rand.Read(b); err != nil {
		return Identity{}, err
	}
	i := Identity{InstallationID: hex.EncodeToString(b)}
	// Exclusive creation prevents two first starts from choosing different identities.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return Load(directory)
	}
	if err != nil {
		return i, err
	}
	body, _ = json.Marshal(i)
	_, err = f.Write(body)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	return i, err
}
func SaveBinding(directory string, i *Identity, epoch int64) error {
	if epoch <= 0 || (i.BindingEpoch != 0 && i.BindingEpoch != epoch) {
		return fmt.Errorf("binding epoch conflict: local=%d remote=%d", i.BindingEpoch, epoch)
	}
	if i.BindingEpoch == epoch {
		return nil
	}
	next := *i
	next.BindingEpoch = epoch
	body, _ := json.Marshal(next)
	f, err := os.CreateTemp(directory, ".identity-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(body)
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
	if err = os.Rename(f.Name(), filepath.Join(directory, "identity.json")); err != nil {
		return err
	}
	*i = next
	return nil
}

// WriteConfig validates and atomically writes a private configuration file.
func WriteConfig(path string, c Config, replace bool) error {
	body, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	directory := filepath.Dir(path)
	if err = os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(directory, ".config-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(body)
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
	validated, err := LoadConfig(f.Name())
	if err != nil {
		return err
	}
	existing, err := LoadConfig(path)
	if err == nil {
		if existing.PanelURL == validated.PanelURL && existing.Token == validated.Token && filepath.Clean(existing.StateDirectory) == filepath.Clean(validated.StateDirectory) {
			return nil
		}
		if existing.PanelURL != validated.PanelURL {
			return errors.New("existing installation belongs to a different panel; preserve it and use an independent installation and state directory")
		}
		if filepath.Clean(existing.StateDirectory) != filepath.Clean(validated.StateDirectory) {
			return errors.New("existing installation state directory cannot be changed; preserve the original identity and state database")
		}
		if !replace {
			return errors.New("existing configuration differs; back it up and explicitly use -replace-config")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("existing configuration cannot be read: %w", err)
	}
	return os.Rename(f.Name(), path)
}
