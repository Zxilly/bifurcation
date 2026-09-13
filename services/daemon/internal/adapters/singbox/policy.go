package singbox

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
)

type Authorization struct {
	Version        int              `json:"version"`
	PolicyRevision string           `json:"policyRevision"`
	Users          []AuthorizedUser `json:"users"`
}
type AuthorizedUser struct {
	ID                string `json:"id"`
	TrojanPassword    string `json:"trojanPassword"`
	Hysteria2Password string `json:"hysteria2Password"`
}

func parseAuthorization(data []byte) (Authorization, int64, []byte, error) {
	var auth Authorization
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&auth); err != nil {
		return auth, 0, nil, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return auth, 0, nil, errors.New("trailing authorization data")
	}
	revision, err := strconv.ParseInt(auth.PolicyRevision, 10, 64)
	if err != nil || revision < 1 || auth.Version != 1 {
		return auth, 0, nil, errors.New("invalid authorization version")
	}
	seen := map[string]bool{}
	for _, user := range auth.Users {
		if user.ID == "" || strings.Contains(user.ID, ">") || seen[user.ID] || user.TrojanPassword == "" || user.Hysteria2Password == "" {
			return auth, 0, nil, errors.New("invalid authorization user")
		}
		seen[user.ID] = true
	}
	canonical, err := json.Marshal(auth)
	return auth, revision, canonical, err
}
func decodeConfig(data []byte) (map[string]any, error) {
	if len(data) == 0 || len(data) > 4<<20 {
		return nil, errors.New("invalid configuration size")
	}
	var config map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&config); err != nil {
		return nil, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("trailing configuration data")
	}
	if config == nil {
		return nil, errors.New("configuration must be an object")
	}
	return config, nil
}

// MergeAuthorization changes only managed user lists and the Stats allowlist.
func MergeAuthorization(configJSON, authorizationJSON []byte) ([]byte, error) {
	auth, _, _, err := parseAuthorization(authorizationJSON)
	if err != nil {
		return nil, err
	}
	config, err := decodeConfig(configJSON)
	if err != nil {
		return nil, err
	}
	inbounds, ok := config["inbounds"].([]any)
	if !ok {
		return nil, errors.New("managed inbounds are missing")
	}
	found := map[string]bool{}
	for _, raw := range inbounds {
		inbound, ok := raw.(map[string]any)
		if !ok {
			return nil, errors.New("invalid inbound")
		}
		tag, _ := inbound["tag"].(string)
		protocol := ""
		switch tag {
		case "bifurcation-trojan":
			protocol = "trojan"
		case "bifurcation-hysteria2":
			protocol = "hysteria2"
		default:
			continue
		}
		if found[tag] || inbound["type"] != protocol {
			return nil, errors.New("managed inbound conflict")
		}
		found[tag] = true
		users := make([]any, 0, len(auth.Users))
		for _, u := range auth.Users {
			password := u.TrojanPassword
			if protocol == "hysteria2" {
				password = u.Hysteria2Password
			}
			users = append(users, map[string]any{"name": u.ID, "password": password})
		}
		inbound["users"] = users
	}
	if len(found) != 2 {
		return nil, errors.New("both managed inbounds are required")
	}
	return json.Marshal(config)
}
