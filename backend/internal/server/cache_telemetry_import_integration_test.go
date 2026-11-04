package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestCacheTelemetryImportIntegration(t *testing.T) {
	uri, address := os.Getenv("GO_TEST_MONGODB_URI"), os.Getenv("GO_TEST_REDIS_ADDR")
	if uri == "" || address == "" {
		t.Skip("requires disposable MongoDB/Redis and Node dependencies")
	}
	if !strings.HasPrefix(uri, "mongodb://127.0.0.1:") || !strings.HasPrefix(address, "127.0.0.1:") {
		t.Fatal("requires local disposable services")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	database := "cache_import_" + bson.NewObjectID().Hex()
	config := Config{MongoURI: uri, Database: database, RedisAddress: address}
	store, err := Connect(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close(context.Background())
	defer store.DB.Drop(context.Background())
	command := exec.CommandContext(ctx, "node", filepath.Join("..", "..", "scripts", "test-cache-telemetry-import.cjs"))
	command.Env = append(os.Environ(), "GO_TEST_MONGODB_DATABASE="+database)
	var stderr strings.Builder
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		t.Fatalf("telemetry import: %v\n%s", err, stderr.String())
	}
	var expected map[string]M
	if err = json.Unmarshal(output, &expected); err != nil {
		t.Fatal(err, string(output))
	}
	s := &Server{Store: store, cacheMetrics: testCacheMetrics()}
	for _, minutes := range []string{"15", "60", "1440", "10080"} {
		t.Run(minutes, func(t *testing.T) {
			out, err := s.cacheTelemetry(&request{W: httptest.NewRecorder(), R: httptest.NewRequest("GET", "/?minutes="+minutes, nil)})
			if err != nil || !boolean(obj(out)["available"]) {
				t.Fatal(out, err)
			}
			got := M{"rows": obj(out)["rows"], "dropped": obj(out)["dropped"]}
			data, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var normalized M
			json.Unmarshal(data, &normalized)
			if !reflect.DeepEqual(normalized, expected[minutes]) {
				t.Fatalf("Go report %s\nNode report %v", data, expected[minutes])
			}
		})
	}
	// New Go observations add to the same report without touching imported rows.
	s.observeCache(context.Background(), "source_hit", 123, time.Millisecond)
	if err = s.flushCacheMetrics(ctx); err != nil {
		t.Fatal(err)
	}
	out, err := s.cacheTelemetry(&request{W: httptest.NewRecorder(), R: httptest.NewRequest("GET", "/?minutes=60", nil)})
	if err != nil {
		t.Fatal(err)
	}
	var before, after int64
	for _, row := range expected["60"]["rows"].([]any) {
		before += number(obj(row)["count"])
	}
	for _, row := range obj(out)["rows"].([]M) {
		after += number(row["count"])
	}
	if after != before+1 {
		t.Fatalf("live count=%d, imported=%d", after, before)
	}
}
