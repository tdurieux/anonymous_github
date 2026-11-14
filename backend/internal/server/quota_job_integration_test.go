package server

import (
	"errors"
	"go.mongodb.org/mongo-driver/v2/bson"
	"testing"
	"time"
)

func runQuotaJobIntegration(t *testing.T, base *Server) {
	ctx := t.Context()
	db := base.Store.DB.Client().Database("quota_job_test_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	config := base.Config
	config.Root = t.TempDir()
	config.Billing = BillingConfig{Enabled: true, FreeRepositories: 2, FreeStorage: 1}
	p := &delayedJobProvider{fixtureProvider: fixtureProvider{name: "team/subgroup/project", commit: "revision:one"}}
	s, err := New(config, &Store{DB: db, Redis: base.Store.Redis}, p)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	owner := bson.NewObjectID()
	if _, err = db.Collection("users").InsertOne(ctx, M{"_id": owner, "status": "active"}); err != nil {
		t.Fatal(err)
	}
	r := M{"_id": bson.NewObjectID(), "owner": owner, "repoId": "quota-job", "status": "preparing", "statusDate": time.Now(), "billingManaged": true, "source": M{"provider": "fixture", "repositoryName": p.name, "providerRepositoryId": "project:123", "commit": p.commit, "branch": "main"}, "providerAccess": M{"provider": "fixture", "kind": "fixture-grant", "revision": "grant:1"}}
	if _, err = db.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
		t.Fatal(err)
	}
	job := M{"_id": "repo:quota-job:prepare", "kind": "repo", "resourceId": "quota-job", "action": "prepare", "state": "active", "attempts": 1, "lease": "first"}
	if _, err = db.Collection("gojobs").InsertOne(ctx, job); err != nil {
		t.Fatal(err)
	}
	failure := s.runJob(ctx, job)
	var api *APIError
	if !errors.As(failure, &api) || api.Code != "quota_exceeded" {
		t.Fatalf("expected real capacity denial: %v", failure)
	}
	if err = s.finishJob(ctx, job, failure, time.Now()); err != nil {
		t.Fatal(err)
	}
	stored, err := s.Store.one(ctx, "gojobs", M{"_id": job["_id"]})
	if err != nil || stored["state"] != "failed" || number(stored["attempts"]) != 1 {
		t.Fatal("quota retried", stored, err)
	}
	if _, err = s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"statusDate": time.Now().Add(-time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		current, err := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		if current["status"] != "error" || current["statusMessage"] != "quota_exceeded" {
			t.Fatal(current)
		}
		for _, check := range []func() error{func() error { return s.repositoryOptionsCheck(ctx, current) }, func() error { return s.checkResource(ctx, "repo", current) }} {
			e := check()
			if !errors.As(e, &api) || api.Status != 402 {
				t.Fatalf("quota status: %v", e)
			}
		}
	}
	stored, err = s.Store.one(ctx, "gojobs", M{"_id": job["_id"]})
	if err != nil || stored["state"] != "failed" {
		t.Fatal("viewer requeued quota job", stored, err)
	}
	// Increasing capacity and explicit owner refresh must permit a fresh attempt.
	s.Config.Billing.FreeStorage = 1 << 20
	current, err := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.manualRepositoryRefresh(ctx, current); err != nil {
		t.Fatal(err)
	}
	stored, err = s.Store.one(ctx, "gojobs", M{"_id": job["_id"]})
	if err != nil || stored["state"] != "waiting" {
		t.Fatal("owner refresh failed", stored, err)
	}
	if err = s.runJob(ctx, stored); err != nil {
		t.Fatal(err)
	}
	current, err = s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
	if err != nil || current["status"] != "ready" {
		t.Fatal("capacity recovery failed", current, err)
	}
	// Ordinary upstream failures keep the normal retry policy.
	if _, err = s.Store.update(ctx, "gojobs", M{"_id": job["_id"]}, M{"$set": M{"state": "active", "lease": "first", "attempts": 1}}); err != nil {
		t.Fatal(err)
	}
	if err = s.finishJob(ctx, job, fail("upstream_error", 502), time.Now()); err != nil {
		t.Fatal(err)
	}
	stored, err = s.Store.one(ctx, "gojobs", M{"_id": job["_id"]})
	if err != nil || stored["state"] != "waiting" {
		t.Fatal("transient retry lost", stored, err)
	}
}
