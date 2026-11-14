package server

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/logging"
)

func TestWebhookFailureStructuredDiagnostics(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(logging.New(&output, slog.LevelInfo, "")))
	defer slog.SetDefault(previous)
	s := &Server{Config: Config{AppEnabled: true, AppWebhookSecret: "synthetic-key"}}
	payload := `{"secret-repository":`
	mac := hmac.New(sha256.New, []byte(s.Config.AppWebhookSecret))
	mac.Write([]byte(payload))
	r := httptest.NewRequest("POST", "/github/app/webhook?secret-query", strings.NewReader(payload))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	r.Header.Set("X-GitHub-Event", "installation")
	r.Header.Set("X-GitHub-Delivery", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	w := httptest.NewRecorder()
	s.webhook(w, r)
	if w.Code != 503 {
		t.Fatal(w.Code, w.Body.String())
	}
	var record M
	if err := json.Unmarshal(output.Bytes(), &record); err != nil {
		t.Fatal(err, output.String())
	}
	if record["event"] != "webhook_processing_failed" || record["phase"] != "parse" || record["webhookEvent"] != "installation" || record["deliveryId"] == nil {
		t.Fatal(record)
	}
	if strings.Contains(output.String(), "secret") || strings.Contains(output.String(), "synthetic") {
		t.Fatal(output.String())
	}
}
