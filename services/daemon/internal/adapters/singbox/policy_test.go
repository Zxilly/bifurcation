package singbox

import (
	"bytes"
	"encoding/json"
	"testing"
)

func policyFixture() []byte {
	return []byte(`{"inbounds":[{"type":"trojan","tag":"bifurcation-trojan","users":[{"name":"removed","password":"old"}],"listen_port":443},{"type":"hysteria2","tag":"bifurcation-hysteria2","users":[{"name":"removed","password":"old"}],"listen_port":8443},{"type":"direct","tag":"custom","listen_port":9999}],"route":{"final":"direct"}}`)
}
func TestAuthorizationMergeRemovesRevokedCredentialsAndPreservesBase(t *testing.T) {
	auth := []byte(`{"version":1,"policyRevision":"2","users":[{"id":"remaining","trojanPassword":"new-t","hysteria2Password":"new-h"}]}`)
	merged, err := MergeAuthorization(policyFixture(), auth)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(merged, []byte("removed")) || bytes.Contains(merged, []byte(`"old"`)) {
		t.Fatal("revoked credentials survived", string(merged))
	}
	var result map[string]any
	if err = json.Unmarshal(merged, &result); err != nil {
		t.Fatal(err)
	}
	inbounds := result["inbounds"].([]any)
	if inbounds[2].(map[string]any)["listen_port"] != float64(9999) || result["route"].(map[string]any)["final"] != "direct" {
		t.Fatal("base configuration changed")
	}
	for _, bad := range [][]byte{append(auth, []byte(" {}")...), []byte(`{"version":1,"policyRevision":"1","users":[{"id":"bad>>>id","trojanPassword":"x","hysteria2Password":"y"}]}`)} {
		if _, err = MergeAuthorization(policyFixture(), bad); err == nil {
			t.Fatal("invalid authorization accepted")
		}
	}
}
