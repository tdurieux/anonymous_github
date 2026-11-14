package server

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type blockingQueueProvider struct {
	fixtureProvider
	entered chan<- string
	release <-chan struct{}
}

func (p *blockingQueueProvider) Tree(ctx context.Context, a provider.Access) ([]provider.Entry, error) {
	select {
	case p.entered <- "download":
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case <-p.release:
		return nil, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestIndependentWorkerQueuesIntegration(t *testing.T) {
	t.Run("capacity pause resume and cache revision", func(t *testing.T) { runIndependentWorkerQueues(t, false) })
	t.Run("cancel blocked workers", func(t *testing.T) { runIndependentWorkerQueues(t, true) })
}

func runIndependentWorkerQueues(t *testing.T, cancelActive bool) {
	uri, address := os.Getenv("GO_TEST_MONGODB_URI"), os.Getenv("GO_TEST_REDIS_ADDR")
	if uri == "" || address == "" {
		t.Skip("requires disposable MongoDB/Redis")
	}
	if !strings.HasPrefix(uri, "mongodb://127.0.0.1:") || !strings.HasPrefix(address, "127.0.0.1:") {
		t.Fatal("requires local disposable services")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	entered := make(chan string, 30)
	release := make(chan struct{})
	var objectMu sync.Mutex
	freshObjects := map[string]string{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "PUT":
			data, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			objectMu.Lock()
			freshObjects[strings.TrimPrefix(r.URL.Path, "/bucket/")] = string(data)
			objectMu.Unlock()
			w.Header().Set("ETag", `"fixture"`)
		case r.Method == "HEAD":
			objectMu.Lock()
			value, ok := freshObjects[strings.TrimPrefix(r.URL.Path, "/bucket/")]
			objectMu.Unlock()
			if !ok {
				w.WriteHeader(404)
				return
			}
			w.Header().Set("Content-Length", fmt.Sprint(len(value)))
		case r.Method == "GET" && r.URL.Query().Get("list-type") == "2":
			key := r.URL.Query().Get("prefix") + "old"
			fmt.Fprintf(w, "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>%s</Key><Size>3</Size></Contents></ListBucketResult>", key)
		case r.Method == "POST" && r.URL.Query().Has("delete"):
			var payload struct {
				Objects []struct{ Key string } `xml:"Object"`
			}
			if err := xml.NewDecoder(r.Body).Decode(&payload); err != nil || len(payload.Objects) != 1 {
				t.Error("invalid deletion", err)
				w.WriteHeader(400)
				return
			}
			queue := strings.Split(payload.Objects[0].Key, "-")[0]
			select {
			case entered <- queue:
			case <-r.Context().Done():
				return
			}
			select {
			case <-release:
				objectMu.Lock()
				for _, object := range payload.Objects {
					delete(freshObjects, object.Key)
				}
				objectMu.Unlock()
				io.WriteString(w, "<DeleteResult/>")
			case <-r.Context().Done():
				return
			}
		default:
			t.Errorf("unexpected S3 request %s %s", r.Method, r.URL)
			w.WriteHeader(500)
		}
	}))
	defer api.Close()
	config := Config{MongoURI: uri, Database: "worker_queues_" + bson.NewObjectID().Hex(), RedisAddress: address, Root: t.TempDir(), PublicDir: t.TempDir(), Workers: 1, Mask: "XXXX", Storage: "s3", S3Bucket: "bucket", S3Region: "test", S3Endpoint: api.URL, S3ID: "synthetic", S3Secret: "synthetic"}
	store, err := Connect(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close(context.Background())
	defer store.DB.Drop(context.Background())
	s, err := New(config, store, &blockingQueueProvider{entered: entered, release: release})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	pause := func(queue string, value bool) {
		t.Helper()
		var err error
		if value {
			err = store.Redis.Set(ctx, "go:pause:"+queue, "1", 0).Err()
		} else {
			err = store.Redis.Del(ctx, "go:pause:"+queue).Err()
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range workerQueues {
		pause(q.name, false)
	}
	defer store.Redis.Del(context.Background(), "go:pause:download", "go:pause:remove", "go:pause:cache")
	pause("cache", true)
	for _, spec := range []struct {
		queue, action, status string
		count                 int
	}{{"download", "prepare", "preparing", 6}, {"remove", "remove", "removing", 8}, {"cache", "cache", "ready", 8}} {
		for i := 0; i < spec.count; i++ {
			id := fmt.Sprintf("%s-%d", spec.queue, i)
			resource := M{"_id": bson.NewObjectID(), "repoId": id, "status": spec.status, "source": M{"provider": "fixture", "repositoryName": "team/subgroup/project", "repositoryId": "project:123", "commit": "opaque:1"}, "providerAccess": M{"provider": "fixture", "kind": "fixture-grant", "revision": "grant:1"}}
			if _, err := store.DB.Collection(collection("repo")).InsertOne(ctx, resource); err != nil {
				t.Fatal(err)
			}
			if err := s.enqueue(ctx, "repo", id, spec.action); err != nil {
				t.Fatal(err)
			}
		}
	}
	work, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); s.RunJobs(work) }()
	defer func() {
		stop()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("workers did not stop")
		}
	}()
	counts := map[string]int{}
	receive := func(n int) {
		t.Helper()
		for i := 0; i < n; i++ {
			select {
			case q := <-entered:
				counts[q]++
			case <-ctx.Done():
				t.Fatal("workers stalled", counts)
			}
		}
	}
	receive(8)
	if counts["download"] != 3 || counts["remove"] != 5 || counts["cache"] != 0 {
		t.Fatal("wrong independent capacity", counts)
	}
	pause("remove", true)
	pause("cache", false)
	receive(5)
	if counts["cache"] != 5 {
		t.Fatal("cache starved or exceeded capacity", counts)
	}
	for _, spec := range []struct {
		action string
		count  int64
	}{{"prepare", 3}, {"remove", 5}, {"cache", 5}} {
		n, err := store.DB.Collection("gojobs").CountDocuments(ctx, M{"action": spec.action, "state": "active"})
		if err != nil || n != spec.count {
			t.Fatal("active capacity", spec, n, err)
		}
	}
	if cancelActive {
		stop()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("blocked provider and S3 workers did not stop")
		}
		return
	}
	// Cache reset has published its new revision but its old deletion is
	// blocked. A file fetched under the new revision must survive that deletion.
	cacheJob, err := store.one(ctx, "gojobs", M{"action": "cache", "state": "active"})
	if err != nil || cacheJob == nil {
		t.Fatal(cacheJob, err)
	}
	cached, err := store.one(ctx, collection("repo"), M{"repoId": cacheJob["resourceId"]})
	if err != nil || str(cached["contentCacheRevision"]) == "" {
		t.Fatal(cached, err)
	}
	access, err := s.providerAccess(cached)
	if err != nil {
		t.Fatal(err)
	}
	newPath := rawCachePath(cached, access, provider.Entry{Path: "fresh.txt", Revision: "blob:fresh"})
	if err := s.content.Put(ctx, str(cached["repoId"]), newPath, strings.NewReader("new"), 3, 3); err != nil {
		t.Fatal(err)
	}
	close(release)
	waitCompleted := func(action string, expected int64) {
		t.Helper()
		for {
			n, err := store.DB.Collection("gojobs").CountDocuments(ctx, M{"action": action, "state": "completed"})
			if err != nil {
				t.Fatal(err)
			}
			if n == expected {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatal("jobs did not complete", action, n)
			case <-time.After(20 * time.Millisecond):
			}
		}
	}
	waitCompleted("prepare", 6)
	waitCompleted("cache", 8)
	if size, err := s.content.Size(ctx, str(cached["repoId"]), newPath); err != nil || size != 3 {
		t.Fatal("cache reset deleted new revision content", size, err)
	}
	waitCompleted("remove", 5)
	if n, err := store.DB.Collection("gojobs").CountDocuments(ctx, M{"action": "remove", "state": "waiting"}); err != nil || n != 3 {
		t.Fatal("pause claimed pending removal", n, err)
	}
	pause("remove", false)
	waitCompleted("remove", 8)
	stop()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("RunJobs did not join its workers")
	}
}
