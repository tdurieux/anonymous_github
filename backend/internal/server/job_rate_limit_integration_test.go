package server

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type delayedJobProvider struct {
	fixtureProvider
	treeError error
	onTree    func()
}

func (p *delayedJobProvider) Tree(ctx context.Context, a provider.Access) ([]provider.Entry, error) {
	if p.onTree != nil {
		p.onTree()
	}
	if p.treeError != nil {
		return nil, p.treeError
	}
	return p.fixtureProvider.Tree(ctx, a)
}

func runJobRateLimitIntegration(t *testing.T, base *Server) {
	t.Run("provider quota delays preserve attempts and lifecycle", func(t *testing.T) {
		ctx := context.Background()
		db := base.Store.DB.Client().Database("job_delay_" + bson.NewObjectID().Hex())
		defer db.Drop(ctx)
		p := &delayedJobProvider{}
		registry, err := provider.New(p)
		if err != nil {
			t.Fatal(err)
		}
		s := &Server{Store: &Store{DB: db, Redis: base.Store.Redis}, providers: registry}
		now := time.Now().Truncate(time.Millisecond)
		reset := now.Add(time.Hour)
		resource := M{"_id": bson.NewObjectID(), "repoId": "delayed", "status": "preparing", "statusDate": now, "source": M{"provider": "fixture", "repositoryName": "team/subgroup/project", "repositoryId": "project:123", "commit": "opaque:1"}, "providerAccess": M{"provider": "fixture", "kind": "fixture-grant", "revision": "grant:1"}}
		if _, err := db.Collection(collection("repo")).InsertOne(ctx, resource); err != nil {
			t.Fatal(err)
		}
		job := M{"_id": "repo:delayed:prepare", "kind": "repo", "resourceId": "delayed", "action": "prepare", "state": "active", "attempts": 3, "lease": "lease-1", "leaseUntil": now.Add(2 * time.Minute), "error": "old_error", "finishedAt": now}
		if _, err := db.Collection("gojobs").InsertOne(ctx, job); err != nil {
			t.Fatal(err)
		}
		p.treeError = fmt.Errorf("private provider endpoint: %w", &provider.RateLimitError{ResetAt: reset})
		for i := 0; i < 5; i++ {
			// Claiming a delayed retry increments attempts as jobLoop does.
			if _, err := s.Store.update(ctx, "gojobs", M{"_id": job["_id"]}, M{"$set": M{"state": "active", "attempts": 3, "lease": "lease-1"}}); err != nil {
				t.Fatal(err)
			}
			err := s.runJob(ctx, job)
			if !errors.Is(err, provider.ErrRateLimited) {
				t.Fatalf("unexpected job error: %v", err)
			}
			if err := s.finishJob(ctx, job, err, now); err != nil {
				t.Fatal(err)
			}
			// Maintenance enqueue must not erase the provider's future reset.
			if err := s.enqueue(ctx, "repo", "delayed", "prepare"); err != nil {
				t.Fatal(err)
			}
			stored, err := s.Store.one(ctx, "gojobs", M{"_id": job["_id"]})
			if err != nil {
				t.Fatal(err)
			}
			if stored["state"] != "delayed" || number(stored["attempts"]) != 2 || !date(stored["availableAt"]).Equal(reset) || stored["lease"] != nil || stored["error"] != nil || stored["finishedAt"] != nil {
				t.Fatalf("invalid delayed job: %v", stored)
			}
			ready, err := db.Collection("gojobs").CountDocuments(ctx, M{"state": M{"$in": []string{"waiting", "delayed"}}, "availableAt": M{"$lte": now}})
			if err != nil || ready != 0 {
				t.Fatalf("delay claimable early: %d %v", ready, err)
			}
			r, err := s.Store.one(ctx, collection("repo"), M{"repoId": "delayed"})
			if err != nil {
				t.Fatal(err)
			}
			if r["status"] != "queue" || r["statusMessage"] != fmt.Sprintf("rate_limited:%d", reset.UnixMilli()) {
				t.Fatalf("invalid queued resource: %v", r)
			}
		}
		// An obsolete lease cannot rewrite a replacement job's delay or attempts.
		if _, err := s.Store.update(ctx, "gojobs", M{"_id": job["_id"]}, M{"$set": M{"state": "active", "lease": "replacement", "attempts": 7}}); err != nil {
			t.Fatal(err)
		}
		if err := s.finishJob(ctx, job, p.treeError, now); err != nil {
			t.Fatal(err)
		}
		current, err := s.Store.one(ctx, "gojobs", M{"_id": job["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		if current["lease"] != "replacement" || number(current["attempts"]) != 7 {
			t.Fatalf("replacement overwritten: %v", current)
		}
		// A lifecycle change during the provider call must survive delayed recovery.
		p.onTree = func() {
			if _, err := s.Store.update(ctx, collection("repo"), M{"repoId": "delayed"}, M{"$set": M{"status": "removing", "statusDate": now.Add(time.Second)}}); err != nil {
				t.Fatal(err)
			}
		}
		_ = s.runJob(ctx, job)
		r, err := s.Store.one(ctx, collection("repo"), M{"repoId": "delayed"})
		if err != nil {
			t.Fatal(err)
		}
		if r["status"] != "removing" {
			t.Fatalf("removal overwritten: %v", r)
		}
		p.onTree = nil
		p.treeError = nil
		if _, err := s.Store.update(ctx, collection("repo"), M{"repoId": "delayed"}, M{"$set": M{"status": "queue"}}); err != nil {
			t.Fatal(err)
		}
		job["lease"] = "replacement"
		if err := s.runJob(ctx, job); err != nil {
			t.Fatal(err)
		}
		if err := s.finishJob(ctx, job, nil, reset); err != nil {
			t.Fatal(err)
		}
		r, err = s.Store.one(ctx, collection("repo"), M{"repoId": "delayed"})
		if err != nil {
			t.Fatal(err)
		}
		if r["status"] != "ready" || r["statusMessage"] != nil {
			t.Fatalf("retry did not publish: %v", r)
		}
		current, err = s.Store.one(ctx, "gojobs", M{"_id": job["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		if current["state"] != "completed" || current["lease"] != nil || current["error"] != nil {
			t.Fatalf("retry did not complete: %v", current)
		}

		// Exercise the actual claimant/worker loop: it must release the slot
		// and leave the future job unclaimed with no failed attempt consumed.
		if _, err := s.Store.update(ctx, collection("repo"), M{"repoId": "delayed"}, M{"$set": M{"status": "preparing"}}); err != nil {
			t.Fatal(err)
		}
		p.treeError = &provider.RateLimitError{ResetAt: reset}
		if err := s.enqueue(ctx, "repo", "delayed", "prepare"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.update(ctx, "gojobs", M{"_id": job["_id"]}, M{"$set": M{"state": "delayed", "availableAt": now.Add(-time.Minute)}}); err != nil {
			t.Fatal(err)
		}
		work, cancel := context.WithTimeout(ctx, 5*time.Second)
		done := make(chan struct{})
		go func() { defer close(done); s.jobLoop(work, "download") }()
		defer func() { cancel(); <-done }()
		for {
			current, err = s.Store.one(ctx, "gojobs", M{"_id": job["_id"]})
			if err != nil {
				t.Fatal(err)
			}
			if current["state"] == "delayed" && date(current["availableAt"]).Equal(reset) {
				break
			}
			select {
			case <-work.Done():
				t.Fatal("worker did not persist quota delay")
			case <-time.After(10 * time.Millisecond):
			}
		}
		if number(current["attempts"]) != 0 || current["lease"] != nil || current["error"] != nil {
			t.Fatalf("worker consumed a quota retry: %v", current)
		}
	})
}
