package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestWebhookHTTPContracts(t *testing.T) {
	data, err := os.ReadFile("testdata/webhook-http.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Event, Body, ContentType, Error, Encoding, Wire, Mode string
		Status, Size                                                int
		Tampered, Disabled                                          bool
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			s := &Server{}
			s.Config.AppEnabled = !tc.Disabled
			s.Config.AppID = "123"
			s.Config.AppWebhookSecret = "synthetic-webhook-contract"
			body := tc.Body
			if tc.Size > 0 {
				body = `{"padding":"` + strings.Repeat("x", tc.Size-14) + `"}`
			}
			wire := []byte(body)
			if tc.Encoding != "" {
				var err error
				wire, err = base64.StdEncoding.DecodeString(tc.Wire)
				if err != nil {
					t.Fatal(err)
				}
			}
			signed := []byte(body)
			if tc.Mode == "wire-signature" {
				signed = wire
			}
			mac := hmac.New(sha256.New, []byte(s.Config.AppWebhookSecret))
			mac.Write(signed)
			signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))
			if tc.Tampered {
				signature = "sha256=" + strings.Repeat("0", 64)
			}
			r := httptest.NewRequest("POST", "/github/app/webhook", bytes.NewReader(wire))
			if tc.ContentType != "" {
				r.Header.Set("Content-Type", tc.ContentType)
			}
			r.Header.Set("X-Hub-Signature-256", signature)
			r.Header.Set("X-GitHub-Event", tc.Event)
			if tc.Encoding != "" {
				r.Header.Set("Content-Encoding", tc.Encoding)
			}
			w := httptest.NewRecorder()
			s.webhook(w, r)
			if w.Code != tc.Status {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.Status, w.Body.String())
			}
			if tc.Error != "" {
				var result M
				if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result["error"] != tc.Error {
					t.Fatal("error response differs", w.Body.String(), err)
				}
			}
			if tc.Status == 204 && w.Body.Len() != 0 {
				t.Fatal("204 response has a body")
			}
		})
	}
}
