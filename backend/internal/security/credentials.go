// Package security implements the persisted security contracts shared with the
// TypeScript backend. Errors deliberately exclude key and credential material.
package security

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
)

type Envelope struct {
	Version    int    `json:"version" bson:"version"`
	KeyID      string `json:"keyId" bson:"keyId"`
	Nonce      string `json:"nonce" bson:"nonce"`
	Ciphertext string `json:"ciphertext" bson:"ciphertext"`
	Tag        string `json:"tag" bson:"tag"`
}

type Cipher struct {
	keys   map[string][]byte
	active string
}

func NewCipher(raw, active string) (*Cipher, error) {
	var values map[string]string
	if json.Unmarshal([]byte(raw), &values) != nil || len(values) == 0 {
		return nil, errors.New("invalid_credential_keyring")
	}
	keys := make(map[string][]byte, len(values))
	for id, value := range values {
		decoded, err := decode64(value)
		if err != nil || id == "" || len(decoded) != 32 {
			return nil, errors.New("invalid_credential_keyring")
		}
		keys[id] = decoded
	}
	if _, ok := keys[active]; !ok {
		return nil, errors.New("missing_active_credential_key")
	}
	return &Cipher{keys, active}, nil
}

func decode64(s string) ([]byte, error) {
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil || s == "" || base64.StdEncoding.EncodeToString(b) != s {
		return nil, errors.New("invalid_base64")
	}
	return b, nil
}

// JSJSON uses JSON.stringify's non-HTML-escaped string encoding. AAD must be
// identical across languages; Go's default JSON HTML escaping changes it.
func JSJSON(v any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	out := bytes.TrimSuffix(b.Bytes(), []byte{'\n'})
	out = bytes.ReplaceAll(out, []byte(`\u2028`), []byte("\u2028"))
	out = bytes.ReplaceAll(out, []byte(`\u2029`), []byte("\u2029"))
	return out, nil
}

func aad(owner, provider, purpose string) []byte {
	b, _ := JSJSON([]any{"credentials", owner, provider, purpose, 1})
	return b
}
func gcm(key []byte) (cipher.AEAD, error) {
	b, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	return cipher.NewGCM(b)
}

func (c *Cipher) Encrypt(token, owner, provider, purpose string) (Envelope, error) {
	if token == "" {
		return Envelope{}, errors.New("empty_credential")
	}
	if purpose == "" {
		purpose = "encryptedToken"
	}
	a, err := gcm(c.keys[c.active])
	if err != nil {
		return Envelope{}, errors.New("credential_encryption_failed")
	}
	nonce := make([]byte, 12)
	if _, err = rand.Read(nonce); err != nil {
		return Envelope{}, errors.New("credential_encryption_failed")
	}
	sealed := a.Seal(nil, nonce, []byte(token), aad(owner, provider, purpose))
	enc := base64.StdEncoding.EncodeToString
	return Envelope{1, c.active, enc(nonce), enc(sealed[:len(sealed)-16]), enc(sealed[len(sealed)-16:])}, nil
}

func (c *Cipher) Decrypt(e Envelope, owner, provider, purpose string) (string, error) {
	fail := errors.New("Credential decryption failed")
	if purpose == "" {
		purpose = "encryptedToken"
	}
	key, ok := c.keys[e.KeyID]
	if !ok || e.Version != 1 {
		return "", fail
	}
	nonce, nerr := decode64(e.Nonce)
	tag, terr := decode64(e.Tag)
	data, derr := decode64(e.Ciphertext)
	if nerr != nil || terr != nil || derr != nil || len(nonce) != 12 || len(tag) != 16 {
		return "", fail
	}
	a, err := gcm(key)
	if err != nil {
		return "", fail
	}
	plain, err := a.Open(nil, nonce, append(data, tag...), aad(owner, provider, purpose))
	if err != nil {
		return "", fail
	}
	return string(plain), nil
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func RandomToken() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return hex.EncodeToString(b), err
}

// SignSession is compatible with express-session/cookie-signature.
func SignSession(id, secret string) string {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(id))
	return "s:" + id + "." + base64.RawStdEncoding.EncodeToString(h.Sum(nil))
}
func VerifySession(value, secret string) (string, bool) {
	if !strings.HasPrefix(value, "s:") {
		return "", false
	}
	i := strings.LastIndexByte(value, '.')
	if i < 3 || i > 258 {
		return "", false
	}
	id := value[2:i]
	if !hmac.Equal([]byte(value), []byte(SignSession(id, secret))) {
		return "", false
	}
	return id, true
}
func VerifyWebhook(body []byte, signature, secret string) bool {
	if secret == "" || !strings.HasPrefix(signature, "sha256=") {
		return false
	}
	provided, err := hex.DecodeString(strings.TrimPrefix(signature, "sha256="))
	if err != nil {
		return false
	}
	h := hmac.New(sha256.New, []byte(secret))
	h.Write(body)
	return hmac.Equal(provided, h.Sum(nil))
}
