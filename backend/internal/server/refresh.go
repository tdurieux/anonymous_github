package server

import (
	"context"
	"errors"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"time"
)

// A durable compare-and-swap claim prevents simultaneous viewers from starting
// competing refreshes. Failure leaves the saved tree intact.
func (s *Server) autoRefresh(ctx context.Context, r M) error {
	if boolean(r["billingManaged"]) {
		allowed, err := s.billingAutomaticUpdates(ctx, str(r["owner"]), str(r["repoId"]), str(r["conference"]))
		if err != nil {
			return err
		}
		if !allowed {
			return nil
		}
	}
	return s.updateRepository(ctx, r, false, "")
}
func refreshRevisionFilter(r M, token string) M {
	f := revisionFilter(r)
	if token != "" {
		f["refreshToken"] = token
		f["refreshUntil"] = M{"$gt": time.Now()}
	}
	return f
}
func (s *Server) updateRepository(ctx context.Context, r M, force bool, token string) error {
	source := obj(r["source"])
	lastView, hasLastView := storedDate(r["lastView"])
	if str(source["type"]) == "Zip" || (!force && (!hasLastView || !boolean(obj(r["options"])["update"]) || lastView.After(time.Now().Add(-24*time.Hour)))) {
		return nil
	}
	if !force && (date(r["refreshUntil"]).After(time.Now()) || date(r["goRefreshCheckedAt"]).After(time.Now().Add(-30*time.Second))) {
		return nil
	}
	filter := refreshRevisionFilter(r, token)
	if token == "" {
		filter["$or"] = []M{{"refreshUntil": M{"$exists": false}}, {"refreshUntil": M{"$lte": time.Now()}}}
	}
	filter["goRefreshCheckedAt"] = r["goRefreshCheckedAt"]
	now := time.Now()
	claimed, e := s.Store.update(ctx, collection("repo"), filter, M{"$set": M{"goRefreshCheckedAt": now}})
	if e != nil {
		return e
	}
	if !claimed {
		if force {
			return fail("repository_changed", 409)
		}
		return nil
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		s.Store.update(cleanup, collection("repo"), M{"_id": r["_id"], "goRefreshCheckedAt": now}, M{"$unset": M{"goRefreshCheckedAt": ""}})
	}()
	p, a, e := s.repositoryProvider(r)
	if e != nil {
		return e
	}
	a, e = s.resolveSourceIdentity(ctx, r, a)
	if e != nil {
		return e
	}
	if e = p.Authorize(ctx, a); e != nil {
		return e
	}
	metadata, e := p.Repository(ctx, a)
	if e != nil {
		return e
	}
	if e = validateRepositoryIdentity(a, metadata); e != nil {
		return e
	}
	a.Ref.Name = metadata.Name
	resolved, e := p.Branch(ctx, a, a.Ref.Branch)
	if errors.Is(e, provider.ErrBranchNotFound) {
		return s.missingBranch(ctx, r, token)
	}
	if e != nil {
		return providerFailure(e)
	}
	commit := resolved.ID
	if commit == str(source["commit"]) && str(r["status"]) == "ready" {
		saved, err := s.Store.update(ctx, collection("repo"), refreshRevisionFilter(r, token), M{"$set": M{"source.repositoryName": metadata.Name, "source.providerRepositoryId": metadata.ID}})
		if err != nil {
			return err
		}
		if !saved {
			return fail("repository_changed", 409)
		}
		source["repositoryName"] = metadata.Name
		source["providerRepositoryId"] = metadata.ID
		return nil
	}
	filter = refreshRevisionFilter(r, token)
	filter["goRefreshCheckedAt"] = now
	generation, e := security.RandomToken()
	if e != nil {
		return e
	}
	oldGeneration, oldPrefix := str(r["treeGeneration"]), contentPrefix(r)
	changed, e := s.Store.update(ctx, collection("repo"), filter, M{"$set": M{"source.commit": commit, "source.commitDate": resolved.Date, "source.repositoryName": metadata.Name, "source.providerRepositoryId": metadata.ID, "anonymizeDate": now, "status": "preparing", "statusDate": now, "treeGeneration": generation, "size": M{"storage": 0, "file": 0}, "isReseted": true}, "$unset": M{"statusMessage": "", "pathIndexKey": "", "pathIndexBuiltAt": "", "sizeComputedAt": "", "emptyTreeGeneration": ""}, "$addToSet": M{"retiredTreeGenerations": oldGeneration, "retiredContentPrefixes": oldPrefix}})
	if e != nil {
		return e
	}
	if !changed {
		return fail("repository_changed", 409)
	}
	source["commit"] = commit
	source["commitDate"] = resolved.Date
	source["repositoryName"] = metadata.Name
	source["providerRepositoryId"] = metadata.ID
	r["anonymizeDate"] = now
	r["status"] = "preparing"
	r["statusDate"] = now
	delete(r, "statusMessage")
	r["treeGeneration"] = generation
	r["size"] = M{"storage": 0, "file": 0}
	r["isReseted"] = true
	current, e := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
	if e != nil {
		return e
	}
	if current == nil {
		return fail("repository_changed", 409)
	}
	if e = s.cleanupRepositoryTrees(ctx, current); e != nil {
		return e
	}
	if e = s.cleanupContent(ctx, current); e != nil {
		return e
	}
	current, e = s.Store.one(ctx, collection("repo"), refreshRevisionFilter(r, token))
	if e != nil {
		return e
	}
	if current == nil {
		return fail("repository_changed", 409)
	}
	if e = s.enqueue(ctx, "repo", str(r["repoId"]), "prepare"); e != nil {
		return e
	}
	return nil
}

// Embedded documents refresh synchronously on public options, as in the TS
// routes. Claim and publication compare revisions so a concurrent edit/removal
// cannot be overwritten by an upstream request that finishes later.
func (s *Server) refreshEmbedded(ctx context.Context, kind string, r M) error {
	now := time.Now()
	claimed, e := s.Store.update(ctx, collection(kind), revisionFilter(r), M{"$set": M{"status": "download", "statusDate": now}})
	if e != nil {
		return e
	}
	if !claimed {
		return fail("repository_changed", 409)
	}
	r["status"] = "download"
	r["statusDate"] = now
	if e = s.prepareEmbedded(ctx, kind, r); e != nil {
		code := "preparation_failed"
		var api *APIError
		if errors.As(providerFailure(e), &api) {
			code = api.Code
		}
		_, saveErr := s.Store.update(ctx, collection(kind), revisionFilter(r), M{"$set": M{"status": "error", "statusDate": time.Now(), "statusMessage": code}})
		if saveErr != nil {
			return saveErr
		}
		return e
	}
	current, e := s.Store.one(ctx, collection(kind), M{"_id": r["_id"]})
	if e != nil {
		return e
	}
	if current == nil {
		return fail(missing(kind), 404)
	}
	for k := range r {
		delete(r, k)
	}
	for k, v := range current {
		r[k] = v
	}
	return nil
}
func (s *Server) embeddedOptionsCheck(ctx context.Context, kind string, r M) error {
	prefix := "gist"
	notReady := 425
	if kind == "pr" {
		prefix = "pull_request"
		notReady = 404
	}
	status := str(r["status"])
	switch status {
	case "expired", "expiring", "removing", "removed":
		return fail(prefix+"_expired", 410)
	}
	if status != "ready" {
		if d, valid := storedDate(r["statusDate"]); valid && d.Before(time.Now().Add(-5*time.Minute)) {
			if e := s.refreshEmbedded(ctx, kind, r); e != nil {
				return e
			}
		}
		if str(r["status"]) == "error" {
			code := str(r["statusMessage"])
			if code == "" {
				code = prefix + "_not_available"
			}
			return fail(code, 500)
		}
		// TS returns not-ready for this request even when forced recovery completed.
		return fail(prefix+"_not_ready", notReady)
	}
	if d, valid := storedDate(r["anonymizeDate"]); boolean(obj(r["options"])["update"]) && valid && d.Before(time.Now().Add(-24*time.Hour)) {
		return s.refreshEmbedded(ctx, kind, r)
	}
	return nil
}

func (s *Server) repositoryOptionsCheck(ctx context.Context, r M) error {
	status := str(r["status"])
	switch status {
	case "ready":
		if e := s.checkResource(ctx, "repo", r); e != nil {
			return e
		}
		return s.autoRefresh(ctx, r)
	case "queue", "archived", "expired", "expiring", "removed", "removing":
		return s.checkResource(ctx, "repo", r)
	}
	if d, valid := storedDate(r["statusDate"]); valid && d.Before(time.Now().Add(-5*time.Minute)) {
		now := time.Now()
		changed, e := s.Store.update(ctx, collection("repo"), revisionFilter(r), M{"$set": M{"status": "preparing", "statusDate": now}, "$unset": M{"statusMessage": ""}})
		if e != nil {
			return e
		}
		if !changed {
			return fail("repository_changed", 409)
		}
		r["status"] = "preparing"
		r["statusDate"] = now
		delete(r, "statusMessage")
		if e = s.enqueue(ctx, "repo", str(r["repoId"]), "prepare"); e != nil {
			return e
		}
	}
	return s.checkResource(ctx, "repo", r)
}

// Detach the failed tree before retiring its rows. Cleanup cannot delete a tree
// published by a concurrent edit because the state transition uses a revision CAS.
func (s *Server) missingBranch(ctx context.Context, r M, token string) error {
	generation, e := security.RandomToken()
	if e != nil {
		return e
	}
	now := time.Now()
	changed, e := s.Store.update(ctx, collection("repo"), refreshRevisionFilter(r, token), M{"$set": M{"treeGeneration": generation, "status": "error", "statusDate": now, "statusMessage": "branch_not_found", "size": M{"storage": 0, "file": 0}, "isReseted": true}, "$unset": M{"pathIndexKey": "", "pathIndexBuiltAt": "", "sizeComputedAt": "", "emptyTreeGeneration": ""}, "$addToSet": M{"retiredTreeGenerations": str(r["treeGeneration"]), "retiredContentPrefixes": contentPrefix(r)}})
	if e != nil {
		return e
	}
	if !changed {
		return fail("repository_changed", 409)
	}
	if e = s.cleanupRepositoryTrees(ctx, r); e != nil {
		return e
	}
	current, e := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
	if e != nil {
		return e
	}
	if current != nil {
		if e = s.cleanupContent(ctx, current); e != nil {
			return e
		}
	}
	return fail("branch_not_found", 404)
}

func (s *Server) manualRepositoryRefresh(ctx context.Context, r M) (result error) {
	status := str(r["status"])
	switch status {
	case "archived":
		return fail("repository_archived", 410)
	case "preparing", "queue", "removing", "expiring":
		return fail("invalid_status", 409)
	case "download":
		if date(r["statusDate"]).After(time.Now().Add(-5 * time.Minute)) {
			return fail("invalid_status", 409)
		}
	}
	now := time.Now()
	token, e := security.RandomToken()
	if e != nil {
		return e
	}
	filter := revisionFilter(r)
	filter["$and"] = []M{{"$or": []M{{"refreshUntil": M{"$exists": false}}, {"refreshUntil": M{"$lte": now}}}}, {"$or": []M{{"goRefreshCheckedAt": M{"$exists": false}}, {"goRefreshCheckedAt": M{"$lte": now.Add(-30 * time.Second)}}}}}
	claimed, e := s.Store.update(ctx, collection("repo"), filter, M{"$set": M{"refreshToken": token, "refreshUntil": now.Add(5 * time.Minute)}})
	if e != nil {
		return e
	}
	if !claimed {
		return fail("invalid_status", 409)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if result != nil && str(r["status"]) == "preparing" {
			failed := revisionFilter(r)
			failed["refreshToken"] = token
			s.Store.update(cleanup, collection("repo"), failed, M{"$set": M{"status": "error", "statusDate": time.Now(), "statusMessage": "preparation_interrupted"}})
		}
		s.Store.update(cleanup, collection("repo"), M{"_id": r["_id"], "refreshToken": token}, M{"$unset": M{"refreshToken": "", "refreshUntil": ""}})
	}()
	key := "repo:" + str(r["repoId"]) + ":prepare"
	job, e := s.Store.one(ctx, "gojobs", M{"_id": key})
	if e != nil {
		return e
	}
	if job != nil {
		if str(job["state"]) != "completed" && str(job["state"]) != "failed" {
			return fail("invalid_status", 409)
		}
		deleted, e := s.Store.DB.Collection("gojobs").DeleteOne(ctx, M{"_id": key, "state": job["state"], "finishedAt": job["finishedAt"]})
		if e != nil {
			return e
		}
		if deleted.DeletedCount == 0 {
			return fail("invalid_status", 409)
		}
	}
	return s.updateRepository(ctx, r, true, token)
}
