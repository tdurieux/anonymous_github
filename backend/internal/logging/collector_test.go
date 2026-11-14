package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Runs the unmodified PR #956 collector against actual Go log records.
func TestVectorCollector(t *testing.T) {
	image := os.Getenv("GO_TEST_VECTOR_IMAGE")
	if image == "" {
		t.Skip("set GO_TEST_VECTOR_IMAGE to run the isolated collector")
	}
	var records bytes.Buffer
	logger := slog.New(New(&records, slog.LevelInfo, "abcdef123"))
	logger.Info("request", "requestId", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "route", "/api/repo/:id/file/:path", "status", 200, "ms", 42, "stages", map[string]float64{"upstream": 12})
	logger.With("service", "worker", "jobId", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb").Error("job failed", "queue", "download", "code", "quota_exceeded", "attempt", 2, "error", "secret-repository")
	logger.Info("process heartbeat", "rss", 123456, "memoryRatio", 0.25, "uptime", 30)
	dir := t.TempDir()
	program, err := os.ReadFile("testdata/collector.vrl")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "collector.vrl"), append(program, []byte("\nencode_json(.)\n")...), 0600); err != nil {
		t.Fatal(err)
	}
	var input bytes.Buffer
	for _, line := range strings.Split(strings.TrimSpace(records.String()), "\n") {
		raw, _ := json.Marshal(map[string]any{"log": line, "attrs": map[string]any{"tag": "api"}})
		if err = json.NewEncoder(&input).Encode(map[string]any{"file": "/host/docker/fixture/fixture-json.log", "message": string(raw)}); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.WriteFile(filepath.Join(dir, "input.jsonl"), input.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(t.Context(), "docker", "run", "--rm", "--network", "none", "-e", "VECTOR_LOG=error", "--user", "0:0", "-v", dir+":/fixture:ro", image, "vrl", "-p", "/fixture/collector.vrl", "-i", "/fixture/input.jsonl")
	output, err := command.Output()
	if err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	for i, event := range []string{"request_completed", "job_failed", "process_heartbeat"} {
		var row map[string]any
		var encoded string
		if err = decoder.Decode(&encoded); err == nil {
			err = json.Unmarshal([]byte(encoded), &row)
		}
		if err != nil {
			t.Fatalf("%v: %s", err, output)
		}
		if row["event"] != event {
			t.Fatal(row)
		}
		if i == 0 && (row["route"] != "/api/repo/:id/file/:path" || row["stage_upstream_ms"] != float64(12) || row["requestId"] == nil) {
			t.Fatal(row)
		}
		if i == 1 && (row["service"] != "worker" || row["errorCode"] != "quota_exceeded" || row["severity"] != "error" || row["jobId"] == nil) {
			t.Fatal(row)
		}
		if i == 2 && row["memoryRatio"] != 0.25 {
			t.Fatal(row)
		}
	}
	if strings.Contains(string(output), "secret") {
		t.Fatal(string(output))
	}
}
