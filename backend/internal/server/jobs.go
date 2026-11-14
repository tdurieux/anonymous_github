package server

import (
	"context"
	"errors"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Jobs use a separate collection. The offline handoff tool reads BullMQ via
// its public API; runtime workers never interpret its private Redis format.
func (s *Server) enqueue(ctx context.Context, kind, id, action string) error {
	// Imported BullMQ jobs retain their individual identities. Maintenance
	// must not create a second canonical job while one of them is live.
	var pending M
	err := s.Store.DB.Collection("gojobs").FindOne(ctx, M{"kind": kind, "resourceId": id, "action": action, "state": M{"$in": []string{"active", "waiting", "delayed"}}}, options.FindOne().SetProjection(M{"_id": 1})).Decode(&pending)
	if err == nil {
		return nil
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return err
	}
	key := kind + ":" + id + ":" + action
	_, err = s.Store.DB.Collection("gojobs").UpdateOne(ctx, M{"_id": key, "state": M{"$nin": []string{"active", "waiting", "delayed"}}}, M{"$set": M{"kind": kind, "resourceId": id, "action": action, "state": "waiting", "attempts": 0, "priority": 0, "availableAt": time.Now(), "createdAt": time.Now()}}, options.UpdateOne().SetUpsert(true))
	if mongo.IsDuplicateKeyError(err) {
		return nil
	}
	return err
}

var workerQueues = [...]struct {
	name        string
	concurrency int
}{
	{"download", 3},
	{"remove", 5},
	{"cache", 5},
}

func (s *Server) RunJobs(ctx context.Context) {
	s.removalRecoveryPending.Store(true)
	s.recoverImportedRemovalJobs(ctx)
	var workers sync.WaitGroup
	if s.Config.Billing.Enabled {
		workers.Go(func() { s.runBillingMaintenance(ctx) })
	}
	for _, queue := range workerQueues {
		for i := 0; i < queue.concurrency; i++ {
			workers.Go(func() { s.jobLoop(ctx, queue.name) })
		}
	}
	defer workers.Wait()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.maintenance(ctx)
		}
	}
}
func (s *Server) jobLoop(ctx context.Context, queue string) {
	if ctx.Err() != nil {
		return
	}
	for i, definition := range workerQueues {
		if definition.name == queue {
			s.jobWorkerCounts[i].Add(1)
			defer s.jobWorkerCounts[i].Add(-1)
			break
		}
	}

	allowed := queueActions(queue)
	if len(allowed) == 0 {
		return
	}
	for ctx.Err() == nil {
		token, err := security.RandomToken()
		if err != nil {
			return
		}
		now := time.Now()
		paused, pauseErr := s.Store.Redis.Exists(ctx, "go:pause:"+queue).Result()
		if pauseErr != nil || paused != 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
				continue
			}
		}
		var job M
		err = s.Store.DB.Collection("gojobs").FindOneAndUpdate(ctx, M{"action": M{"$in": allowed}, "$or": []M{{"state": M{"$in": []string{"waiting", "delayed"}}, "availableAt": M{"$lte": now}}, {"state": "active", "leaseUntil": M{"$lt": now}}}}, M{"$set": M{"state": "active", "lease": token, "leaseUntil": now.Add(2 * time.Minute), "startedAt": now}, "$inc": M{"attempts": 1}}, options.FindOneAndUpdate().SetSort(bson.D{{Key: "priority", Value: 1}, {Key: "availableAt", Value: 1}, {Key: "queueOrder", Value: 1}, {Key: "createdAt", Value: 1}, {Key: "_id", Value: 1}}).SetReturnDocument(options.After)).Decode(&job)
		if err != nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
				continue
			}
		}
		work, cancel := context.WithTimeout(ctx, 90*time.Second)
		jobStarted := time.Now()
		err = s.runJob(work, job)
		if _, delayed := jobRateLimit(job, err, time.Now()); !delayed {
			s.queueMetric(ctx, job, err != nil, time.Since(jobStarted))
		}
		cancel()
		s.finishJob(ctx, job, err, time.Now())
	}
}
func (s *Server) runJob(ctx context.Context, job M) (jobErr error) {
	kind, id, action := str(job["kind"]), str(job["resourceId"]), str(job["action"])
	if collection(kind) == "" {
		return errors.New("invalid_job")
	}
	r, err := s.Store.one(ctx, collection(kind), resourceFilter(kind, id))
	if err != nil || r == nil {
		return err
	}
	if action == "cache" {
		if kind == "repo" {
			return s.resetContentCache(ctx, r)
		}
		return s.content.Remove(ctx, id, "")
	}
	if action == "prepare" {
		defer func() {
			if jobErr != nil {
				_ = s.notifyOwnerAccessProblem(ctx, kind, r, providerFailure(jobErr))
			}
			if jobErr == nil {
				return
			}
			if reset, limited := jobRateLimit(job, jobErr, time.Now()); limited {
				// A stale worker cannot put a removed, reconnected, or replaced
				// resource back in the queue.
				_, err := s.Store.update(ctx, collection(kind), revisionFilter(r), M{"$set": M{"status": "queue", "statusDate": time.Now(), "statusMessage": "rate_limited:" + strconv.FormatInt(reset.UnixMilli(), 10)}})
				if err != nil {
					jobErr = err
				}
				return
			}
			if number(job["attempts"]) >= jobMaxAttempts(job) {
				code := "preparation_failed"
				var api *APIError
				if errors.As(providerFailure(jobErr), &api) {
					code = api.Code
				}
				s.Store.update(ctx, collection(kind), revisionFilter(r), M{"$set": M{"status": "error", "statusDate": time.Now(), "statusMessage": code}})
			}
		}()
	}
	if action == "remove" || action == "expire" {
		expected, target := "removing", "removed"
		if action == "expire" {
			expected, target = "expiring", "expired"
		}
		if str(r["status"]) != expected {
			if action != "remove" {
				return nil
			}
			r, err = s.recoverImportedRemoval(ctx, job, r)
			if err != nil || r == nil {
				return err
			}
		}
		if kind == "repo" {
			snapshot, snapshotErr := s.snapshotRemoval(ctx, r)
			if snapshotErr != nil || snapshot == nil {
				return snapshotErr
			}
			if s.pool != nil {
				s.pool.RemoveResults(id)
			}
			if err = s.deleteRemovalSnapshot(ctx, id, snapshot); err != nil {
				return err
			}
		}
		set := M{"status": target, "statusDate": time.Now(), "size": M{"storage": 0, "file": 0}, "isReseted": true}
		if kind == "gist" {
			set["gist"] = clearedDocumentPayload(kind, r["gist"])
		}
		if kind == "pr" {
			set["pullRequest"] = clearedDocumentPayload(kind, r["pullRequest"])
		}
		_, err = s.Store.update(ctx, collection(kind), revisionFilter(r), M{"$set": set})
		return err
	}
	if str(r["status"]) != "preparing" && str(r["status"]) != "queue" && str(r["status"]) != "download" {
		return nil
	}
	if kind == "repo" {
		return s.prepareTree(ctx, r)
	}
	return s.prepareEmbedded(ctx, kind, r)
}
func (s *Server) prepareTree(ctx context.Context, r M) error {
	p, a, err := s.repositoryProvider(r)
	if err != nil {
		return err
	}
	if err = p.Authorize(ctx, a); err != nil {
		return err
	}
	var files []provider.Entry
	truncated := []string{}
	if partial, ok := p.(provider.PartialTrees); ok {
		files, truncated, err = partial.TreeWithTruncation(ctx, a)
	} else {
		files, err = p.Tree(ctx, a)
	}
	if err != nil {
		return err
	}
	for _, folder := range truncated {
		if folder == "" {
			continue
		}
		normalized, err := security.RelativePath(folder)
		if err != nil || normalized != folder {
			return fail("invalid_file_path", 422)
		}
	}
	entries := make([]any, 0, len(files))
	for _, f := range files {
		kind := "blob"
		if f.Directory {
			kind = "tree"
		}
		if f.Size < 0 {
			return fail("invalid_file_size", 422)
		}
		entries = append(entries, M{"path": f.Path, "sha": f.Revision, "size": f.Size, "type": kind, "upstream": originDocument(f.Origin), "submodule": f.Submodule})
	}
	generation, err := security.RandomToken()
	if err != nil {
		return err
	}
	registered, err := s.Store.update(ctx, "anonymizedrepositories", revisionFilter(r), M{"$push": M{"stagedFileTrees": M{"generation": generation, "until": time.Now().Add(5 * time.Minute)}}})
	if err != nil {
		return err
	}
	if !registered {
		return fail("repository_changed", 409)
	}
	rows := []any{}
	var total int64
	for _, value := range entries {
		item := obj(value)
		p, err := security.RelativePath(str(item["path"]))
		if err != nil {
			return fail("invalid_file_path", 422)
		}
		kind := str(item["type"])
		if kind != "blob" && kind != "tree" {
			continue
		}
		dir, name := path.Split(p)
		row := M{"repoId": r["repoId"], "treeGeneration": generation, "treeStaged": true, "name": name, "path": strings.TrimSuffix(dir, "/"), "sha": item["sha"]}
		if item["upstream"] != nil && len(obj(item["upstream"])) > 0 {
			row["upstream"] = item["upstream"]
		}
		if str(item["submodule"]) != "" {
			row["submodule"] = item["submodule"]
		}
		if kind == "blob" {
			row["size"] = number(item["size"])
			total += number(item["size"])
		}
		rows = append(rows, row)
	}
	if boolean(r["billingManaged"]) {
		if err := s.reserveBillingRepository(ctx, str(r["owner"]), str(r["repoId"]), total, str(r["conference"]), "", 0); err != nil {
			return err
		}
	}
	if len(rows) > 0 {
		if _, err = s.Store.DB.Collection("files").InsertMany(ctx, rows); err != nil {
			return err
		}
	}
	set := M{"treeGeneration": generation, "status": "ready", "statusDate": time.Now(), "publishedAt": time.Now(), "size": M{"storage": total, "file": len(rows)}, "sizeComputedAt": time.Now(), "truncatedFolders": truncated}
	change := M{"$set": set, "$unset": M{"statusMessage": "", "pathIndexKey": "", "pathIndexBuiltAt": ""}}
	change["$addToSet"] = M{"retiredTreeGenerations": str(r["treeGeneration"])}
	if str(obj(r["source"])["type"]) != "Zip" {
		obj(change["$addToSet"])["retiredContentPrefixes"] = contentPrefix(r)
		if r["contentCacheVersion"] == nil {
			set["contentCacheVersion"] = 1
			set["legacyContentCleanupPending"] = true
		}
	}
	publication := treePublicationFilter(r, generation, time.Now())
	saved, err := s.Store.update(ctx, "anonymizedrepositories", publication, change)
	if err != nil || !saved {
		s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": r["repoId"], "treeGeneration": generation})
		if err != nil {
			return err
		}
		return fail("repository_changed", 409)
	}
	_, err = s.Store.DB.Collection("files").UpdateMany(ctx, M{"repoId": r["repoId"], "treeGeneration": generation}, M{"$unset": M{"treeStaged": ""}})
	if err != nil {
		return err
	}
	_, err = s.Store.update(ctx, "anonymizedrepositories", M{"_id": r["_id"], "treeGeneration": generation}, M{"$pull": M{"stagedFileTrees": M{"generation": generation}}})
	return err
}
func (s *Server) prepareEmbedded(ctx context.Context, kind string, r M) error {
	payload, err := s.downloadEmbedded(ctx, kind, r)
	if err != nil {
		return err
	}

	field := "gist"
	if kind == "pr" {
		field = "pullRequest"
	}
	saved, err := s.Store.update(ctx, collection(kind), revisionFilter(r), M{"$set": M{field: payload, "status": "ready", "statusDate": time.Now(), "anonymizeDate": time.Now()}, "$unset": M{"statusMessage": ""}})
	if err != nil {
		return err
	}
	if !saved {
		return fail("repository_changed", 409)
	}
	return nil
}
func (s *Server) maintenance(ctx context.Context) {
	if err := s.reconcileBillingExpiration(ctx); err != nil {
		s.recordError(ctx, err)
	}
	s.recoverImportedRemovalJobs(ctx)
	if s.pool != nil {
		s.pool.PruneResults()
	}
	s.snapshotStats(ctx)
	s.cleanupTrees(ctx)
	if err := s.repairPendingMetadata(ctx); err != nil {
		s.recordError(ctx, err)
	}
	s.reconcileInstallations(ctx)
	s.reconcileGrants(ctx)
	s.replayConferenceMemberships(ctx, "")
	conferences, e := s.Store.list(ctx, "conferences", M{"status": "ready", "endDate": M{"$lte": time.Now()}}, 1000, nil)
	if e == nil {
		for _, c := range conferences {
			current, err := s.reconcileConference(ctx, c)
			if err == nil && current != nil {
				s.expireConference(ctx, current)
			}
		}
	}
	for _, kind := range []string{"repo", "pr", "gist"} {
		rows, err := s.Store.list(ctx, collection(kind), M{"$or": []M{{"status": M{"$in": []string{"preparing", "queue", "download", "removing", "expiring"}}}, {"status": "ready", "options.expirationMode": M{"$ne": "never"}, "options.expirationDate": M{"$lte": time.Now()}}}}, 1000, nil)
		if err != nil {
			continue
		}
		for _, r := range rows {
			action := "prepare"
			switch str(r["status"]) {
			case "ready":
				if s.checkResource(ctx, kind, r) == nil {
					continue
				}
				action = "expire"
			case "expiring":
				action = "expire"
			case "removing":
				action = "remove"
			}
			s.enqueue(ctx, kind, str(r[idKey(kind)]), action)
		}
	}
}

func treePublicationFilter(r M, generation string, now time.Time) M {
	f := revisionFilter(r)
	f["stagedFileTrees"] = M{"$elemMatch": M{"generation": generation, "until": M{"$gt": now}}}
	return f
}
func (s *Server) cleanupTrees(ctx context.Context) {
	rows, e := s.Store.list(ctx, collection("repo"), M{"$or": []M{{"stagedFileTrees.until": M{"$lte": time.Now()}}, {"retiredTreeGenerations": M{"$exists": true}}, {"retiredContentPrefixes": M{"$exists": true}}, {"legacyContentCleanupPending": true}}}, 1000, nil)
	if e != nil {
		return
	}
	for _, r := range rows {
		s.cleanupRepositoryTrees(ctx, r)
		s.cleanupContent(ctx, r)
	}
	s.cleanupStagedRows(ctx)
}
func (s *Server) cleanupRepositoryTrees(ctx context.Context, r M) error {
	now := time.Now()
	for _, v := range arr(r["stagedFileTrees"]) {
		stage := obj(v)
		generation := str(stage["generation"])
		if generation == "" || date(stage["until"]).After(now) {
			continue
		}
		_, e := s.Store.update(ctx, collection("repo"), M{"_id": r["_id"], "treeGeneration": M{"$ne": generation}, "stagedFileTrees": M{"$elemMatch": M{"generation": generation, "until": M{"$lte": now}}}}, M{"$pull": M{"stagedFileTrees": M{"generation": generation}}, "$addToSet": M{"retiredTreeGenerations": generation}})
		if e != nil {
			return e
		}
	}
	current, e := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
	if e != nil || current == nil {
		return e
	}
	for _, generation := range stringsOf(current["retiredTreeGenerations"]) {
		if generation == str(current["treeGeneration"]) {
			continue
		}
		query := M{"repoId": current["repoId"], "treeGeneration": generation}
		if generation == "" {
			query["treeGeneration"] = M{"$exists": false}
		}
		if _, e = s.Store.DB.Collection("files").DeleteMany(ctx, query); e != nil {
			return e
		}
		if _, e = s.Store.update(ctx, collection("repo"), M{"_id": current["_id"]}, M{"$pull": M{"retiredTreeGenerations": generation}}); e != nil {
			return e
		}
	}
	for _, field := range []string{"retiredTreeGenerations", "stagedFileTrees"} {
		if _, e = s.Store.update(ctx, collection("repo"), M{"_id": r["_id"], field + ".0": M{"$exists": false}}, M{"$unset": M{field: ""}}); e != nil {
			return e
		}
	}
	return nil
}

// Inserts may finish after their lease was retired. Row markers let maintenance
// discover and remove that late output even after the staging record is gone.
func (s *Server) cleanupStagedRows(ctx context.Context) {
	cursor, e := s.Store.DB.Collection("files").Aggregate(ctx, []M{{"$match": M{"treeStaged": true}}, {"$group": M{"_id": M{"repoId": "$repoId", "generation": "$treeGeneration"}}}, {"$limit": 1000}})
	if e != nil {
		return
	}
	defer cursor.Close(ctx)
	var rows []M
	if cursor.All(ctx, &rows) != nil {
		return
	}
	for _, row := range rows {
		key := obj(row["_id"])
		id, generation := str(key["repoId"]), str(key["generation"])
		if id == "" || generation == "" {
			continue
		}
		r, e := s.Store.one(ctx, collection("repo"), M{"repoId": id})
		if e != nil {
			continue
		}
		q := M{"repoId": id, "treeGeneration": generation, "treeStaged": true}
		if r != nil && str(r["treeGeneration"]) == generation {
			s.Store.DB.Collection("files").UpdateMany(ctx, q, M{"$unset": M{"treeStaged": ""}})
			continue
		}
		live := false
		for _, v := range arr(r["stagedFileTrees"]) {
			stage := obj(v)
			if str(stage["generation"]) == generation && date(stage["until"]).After(time.Now()) {
				live = true
				break
			}
		}
		if !live {
			s.Store.DB.Collection("files").DeleteMany(ctx, q)
		}
	}
}
