package security

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func testCipher(t *testing.T) *Cipher {
	t.Helper()
	raw, _ := json.Marshal(map[string]string{"v1": base64.StdEncoding.EncodeToString(make([]byte, 32))})
	c, e := NewCipher(string(raw), "v1")
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func TestCredentialBinding(t *testing.T) {
	c := testCipher(t)
	e, err := c.Encrypt("secret-token", "owner", "github", "")
	if err != nil {
		t.Fatal(err)
	}
	value, err := c.Decrypt(e, "owner", "github", "")
	if err != nil || value != "secret-token" {
		t.Fatal(value, err)
	}
	for _, args := range [][3]string{{"other", "github", ""}, {"owner", "github-app-user", ""}, {"owner", "github", "encryptedRefreshToken"}} {
		if _, err := c.Decrypt(e, args[0], args[1], args[2]); err == nil {
			t.Fatal("accepted wrong AAD", args)
		}
	}
	for _, mutate := range []func(*Envelope){func(e *Envelope) { e.Version = 2 }, func(e *Envelope) { e.KeyID = "missing" }, func(e *Envelope) { e.Tag = base64.StdEncoding.EncodeToString(make([]byte, 16)) }, func(e *Envelope) { e.Nonce += "\n" }, func(e *Envelope) { e.Ciphertext = "" }} {
		copy := e
		mutate(&copy)
		if _, err := c.Decrypt(copy, "owner", "github", ""); err == nil {
			t.Fatal("accepted corrupted envelope")
		}
	}
	other, _ := c.Encrypt("secret-token", "owner", "github", "")
	if other.Nonce == e.Nonce {
		t.Fatal("nonce reused")
	}
}
func TestSessionsAndAuthorization(t *testing.T) {
	signed := SignSession("id", "secret")
	if id, ok := VerifySession(signed, "secret"); !ok || id != "id" {
		t.Fatal("round trip")
	}
	if _, ok := VerifySession(signed, "other"); ok {
		t.Fatal("wrong key accepted")
	}
	if _, ok := VerifySession(strings.Replace(signed, "id", "other", 1), "secret"); ok {
		t.Fatal("forged session")
	}
	u := Identity{ID: "1", Username: "renamed", GitHubID: "10", Status: "active"}
	if !u.CanEdit("2", []Coauthor{{Username: "old-name", GitHubID: "10"}}) {
		t.Fatal("stable identity lost")
	}
	if u.CanEdit("2", []Coauthor{{Username: "renamed", GitHubID: "20"}}) {
		t.Fatal("username bypassed GitHub identity")
	}
	u.Admin = true
	u.Status = "banned"
	if u.CanEdit("1", nil) {
		t.Fatal("disabled admin authorized")
	}
}
func TestPathAndRedirectValidation(t *testing.T) {
	for _, s := range []string{"../secret", "a/../secret", "/etc/passwd", "a\\b", "a//b", "a/./b", "a\x00b"} {
		if _, err := RelativePath(s); err == nil {
			t.Errorf("accepted %q", s)
		}
	}
	for _, s := range []string{"//evil.test", "/dashboard\\evil", "/dashboard?x=\r\nLocation:evil", "https://evil.test"} {
		if ReturnTo(s, "/dashboard") != "/dashboard" {
			t.Errorf("accepted redirect %q", s)
		}
	}
}
