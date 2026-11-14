package server

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type handoffProvider struct {
	fixtureProvider
	mu    sync.Mutex
	order []string
}

func (p *handoffProvider) Tree(ctx context.Context, a provider.Access) ([]provider.Entry, error) {
	p.mu.Lock()
	p.order = append(p.order, a.Ref.AnonymousID)
	count := 0
	for _, id := range p.order {
		if id == a.Ref.AnonymousID {
			count++
		}
	}
	p.mu.Unlock()
	if a.Ref.AnonymousID == "handoff-exhausted" || (a.Ref.AnonymousID == "handoff-retry" && count == 1) {
		return nil, provider.ErrUpstream
	}
	return p.fixtureProvider.Tree(ctx, a)
}

func TestBullMQHandoffIntegration(t *testing.T) {
	uri, address := os.Getenv("GO_TEST_MONGODB_URI"), os.Getenv("GO_TEST_REDIS_ADDR")
	if uri == "" || address == "" {
		t.Skip("requires disposable MongoDB/Redis and Node dependencies")
	}
	if !strings.HasPrefix(uri, "mongodb://127.0.0.1:") || !strings.HasPrefix(address, "127.0.0.1:") {
		t.Fatal("requires local disposable services")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	database := "bull_handoff_" + bson.NewObjectID().Hex()
	config := Config{MongoURI: uri, Database: database, RedisAddress: address, Root: t.TempDir(), PublicDir: t.TempDir(), Workers: 1, Mask: "XXXX", Storage: "filesystem"}
	store, err := Connect(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close(context.Background())
	defer store.DB.Drop(context.Background())
	command := exec.CommandContext(ctx, "node", filepath.Join("..", "..", "scripts", "test-bullmq-handoff.cjs"))
	command.Env = append(os.Environ(), "GO_TEST_MONGODB_DATABASE="+database)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("BullMQ rehearsal: %v\n%s", err, output)
	}
	p := &handoffProvider{}
	s, err := New(config, store, p)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// Maintenance sees the imported live jobs instead of introducing duplicates.
	if err := s.enqueue(ctx, "repo", "handoff-duplicate", "prepare"); err != nil {
		t.Fatal(err)
	}
	if n, err := store.DB.Collection("gojobs").CountDocuments(ctx, M{"resourceId": "handoff-duplicate"}); err != nil || n != 2 {
		t.Fatal("imported jobs duplicated", n, err)
	}
	if err := s.recoverImportedRemovalJobs(ctx); err != nil {
		t.Fatal(err)
	}
	work, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		var workers sync.WaitGroup
		for _, queue := range workerQueues {
			workers.Go(func() { s.jobLoop(work, queue.name) })
		}
		workers.Wait()
	}()
	defer func() { stop(); <-done }()
	for {
		count, err := store.DB.Collection("gojobs").CountDocuments(ctx, M{"state": M{"$in": []string{"waiting", "active"}}})
		if err != nil {
			t.Fatal(err)
		}
		if count == 0 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("imported jobs did not finish")
		case <-time.After(20 * time.Millisecond):
		}
	}
	for _, id := range []string{"handoff-ready", "handoff-duplicate", "handoff-high", "handoff-low", "handoff-retry"} {
		r, err := store.one(ctx, "anonymizedrepositories", M{"repoId": id})
		if err != nil || r["status"] != "ready" {
			t.Fatal(id, r, err)
		}
	}
	for _, id := range []string{"handoff-remove", "handoff-terminal", "handoff-failed-remove"} {
		r, err := store.one(ctx, "anonymizedrepositories", M{"repoId": id})
		if err != nil || r["status"] != "removed" {
			t.Fatal(id, r, err)
		}
	}
	retried, err := store.one(ctx, "gojobs", M{"resourceId": "handoff-retry"})
	if err != nil || retried["state"] != "completed" || number(retried["attempts"]) != 2 {
		t.Fatal("imported retry policy ignored", retried, err)
	}
	exhausted, err := store.one(ctx, "gojobs", M{"resourceId": "handoff-exhausted"})
	if err != nil || exhausted["state"] != "failed" || number(exhausted["attempts"]) != 1 {
		t.Fatal("imported attempt limit ignored", exhausted, err)
	}
	failedResource, err := store.one(ctx, "anonymizedrepositories", M{"repoId": "handoff-exhausted"})
	if err != nil || failedResource["status"] != "error" {
		t.Fatal("final imported failure not published", failedResource, err)
	}
	delayed, err := store.one(ctx, "gojobs", M{"resourceId": "handoff-delayed"})
	if err != nil || delayed["state"] != "delayed" || number(delayed["attempts"]) != 0 {
		t.Fatal("delayed job ran early", delayed, err)
	}
	p.mu.Lock()
	order := append([]string{}, p.order...)
	p.mu.Unlock()
	index := func(id string) int {
		for i, v := range order {
			if v == id {
				return i
			}
		}
		return -1
	}
	fifo := []string{"handoff-ready", "handoff-retry", "handoff-exhausted", "handoff-duplicate"}
	for i := 1; i < len(fifo); i++ {
		if index(fifo[i-1]) < 0 || index(fifo[i]) <= index(fifo[i-1]) {
			t.Fatal("waiting order not retained", order)
		}
	}
	if index("handoff-high") < 0 || index("handoff-high") > index("handoff-low") {
		t.Fatal("priority not retained", order)
	}
	if index("handoff-delayed") >= 0 {
		t.Fatal("delayed provider called early", order)
	}
	if _, err := store.update(ctx, "gojobs", M{"_id": delayed["_id"]}, M{"$set": M{"availableAt": time.Now().Add(-time.Second)}}); err != nil {
		t.Fatal(err)
	}
	for {
		current, err := store.one(ctx, "gojobs", M{"_id": delayed["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		if current["state"] == "completed" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("due delayed job did not run")
		case <-time.After(20 * time.Millisecond):
		}
	}
}
