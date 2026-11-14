package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/redis/go-redis/v9"
	"net"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Inject failure after a real staging write without changing the shared client.
type pathBatchHook struct {
	after func(context.Context) error
	fired bool
}

func (h *pathBatchHook) DialHook(next redis.DialHook) redis.DialHook {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		return next(ctx, network, address)
	}
}
func (h *pathBatchHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
func (h *pathBatchHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		err := next(ctx, cmd)
		if err == nil && !h.fired && cmd.Name() == "eval" && len(cmd.Args()) > 1 && strings.Contains(fmt.Sprint(cmd.Args()[1]), "HSETNX") {
			h.fired = true
			return h.after(ctx)
		}
		return err
	}
}

func runPathIndexParityIntegration(t *testing.T, s *Server) {
	t.Run("content path index streams beyond former size limit", func(t *testing.T) {
		ctx := t.Context()
		id := "path-index-large-" + bson.NewObjectID().Hex()
		repo := M{"_id": bson.NewObjectID(), "repoId": id, "status": "ready", "treeGeneration": "fixture", "options": M{"terms": []string{"alice => shared", "bob => shared"}}}
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
			t.Fatal(err)
		}
		defer s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": id})
		defer s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": id})
		directory := strings.Repeat("directory/", 180) + "leaf"
		rows := []any{}
		encodedBytes := 0
		for i := 0; i < 10000; i++ {
			row := M{"repoId": id, "treeGeneration": "fixture", "path": directory, "name": fmt.Sprintf("alice-%05d.txt", i), "sha": fmt.Sprint(i), "size": 1}
			raw, _ := json.Marshal(selectFields(row, "path", "name", "size", "sha"))
			encodedBytes += len(raw) + len("p:"+directory+"/shared-00000.txt")
			rows = append(rows, row)
			if len(rows) == 500 {
				if _, err := s.Store.DB.Collection("files").InsertMany(ctx, rows); err != nil {
					t.Fatal(err)
				}
				rows = nil
			}
		}
		if encodedBytes <= 32*1024*1024 {
			t.Fatal("fixture does not exceed old limit", encodedBytes)
		}
		// This collision occurs after all alice rows, across twenty batches.
		if _, err := s.Store.DB.Collection("files").InsertOne(ctx, M{"repoId": id, "treeGeneration": "fixture", "path": directory, "name": "bob-00000.txt", "sha": "later", "size": 1}); err != nil {
			t.Fatal(err)
		}
		key := "test-large-path-" + bson.NewObjectID().Hex()
		defer s.Store.Redis.Del(ctx, key, key+":lock", key+":owner")
		if err := s.Store.Redis.Set(ctx, key+":lock", "owner", 20*time.Second).Err(); err != nil {
			t.Fatal(err)
		}
		if err := s.buildPathIndex(ctx, repo, key, "owner"); err != nil {
			t.Fatal(err)
		}
		for name, want := range map[string]string{"shared-00000.txt": "0", "shared-09999.txt": "9999"} {
			raw, err := s.Store.Redis.HGet(ctx, key, "p:"+directory+"/"+name).Bytes()
			if err != nil {
				t.Fatal(err)
			}
			var row M
			if err = json.Unmarshal(raw, &row); err != nil || row["sha"] != want {
				t.Fatal(row, err, want)
			}
		}
		if ttl := s.Store.Redis.TTL(ctx, key+":lock").Val(); ttl < 50*time.Second {
			t.Fatal("build lease was not renewed", ttl)
		}
		if ready := s.Store.Redis.HGet(ctx, key, "ready").Val(); ready != "1" {
			t.Fatal("index not published")
		}
		if count := s.Store.Redis.HLen(ctx, key).Val(); count != 10004 {
			t.Fatal("unexpected indexed entries", count)
		}
		if s.Store.Redis.HGet(ctx, key, "collision:"+directory+"/shared-00000.txt").Val() != "1" || s.Store.Redis.HGet(ctx, key, "childcollision:"+directory).Val() != "1" {
			t.Fatal("cross-batch collision markers missing")
		}
		if batches, err := s.Store.Redis.HGet(ctx, key, "batch").Int64(); err != nil || batches < int64((encodedBytes+1024*1024-1)/(1024*1024)) {
			t.Fatal("byte target was not applied", batches, encodedBytes)
		}
	})

	t.Run("content path index rejects lost staging and cancellation", func(t *testing.T) {
		for _, cancelBuild := range []bool{false, true} {
			ctx, cancel := context.WithCancel(t.Context())
			id := "path-index-interrupted-" + bson.NewObjectID().Hex()
			repo := M{"_id": bson.NewObjectID(), "repoId": id, "status": "ready", "treeGeneration": "fixture", "options": M{"terms": []string{"alice => shared"}}}
			if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
				t.Fatal(err)
			}
			defer s.Store.DB.Collection(collection("repo")).DeleteOne(t.Context(), M{"repoId": id})
			defer s.Store.DB.Collection("files").DeleteMany(t.Context(), M{"repoId": id})
			rows := []any{}
			for i := 0; i < 601; i++ {
				rows = append(rows, M{"repoId": id, "treeGeneration": "fixture", "path": "", "name": fmt.Sprintf("alice-%04d.txt", i), "size": 1})
			}
			if _, err := s.Store.DB.Collection("files").InsertMany(ctx, rows); err != nil {
				t.Fatal(err)
			}
			key := "test-interrupted-path-" + bson.NewObjectID().Hex()
			temp := key + ":owner"
			defer s.Store.Redis.Del(t.Context(), key, key+":lock", temp)
			if err := s.Store.Redis.Set(ctx, key+":lock", "owner", time.Minute).Err(); err != nil {
				t.Fatal(err)
			}
			client := redis.NewClient(s.Store.Redis.Options())
			defer client.Close()
			hook := &pathBatchHook{after: func(ctx context.Context) error {
				if cancelBuild {
					cancel()
					return nil
				}
				return s.Store.Redis.Del(ctx, temp).Err()
			}}
			client.AddHook(hook)
			isolated := &Server{Config: s.Config, providers: s.providers, Store: &Store{DB: s.Store.DB, Redis: client}, pathBuilds: s.pathBuilds}
			err := isolated.buildPathIndex(ctx, repo, key, "owner")
			cancel()
			if !hook.fired || err == nil {
				t.Fatal("interrupted build published", hook.fired, err)
			}
			if cancelBuild {
				if !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			} else if err.Error() != "path_index_busy" {
				t.Fatal(err)
			}
			if count := s.Store.Redis.Exists(t.Context(), key, temp).Val(); count != 0 {
				t.Fatal("partial index remained", count)
			}
		}
	})

	t.Run("content path index parity", func(t *testing.T) {
		ctx := t.Context()
		id := "path-index-" + bson.NewObjectID().Hex()
		repo := M{"_id": bson.NewObjectID(), "repoId": id, "status": "ready", "treeGeneration": "fixture", "fileMetadataRevision": "first", "options": M{"terms": []string{"alice => shared", "bob => shared"}}}
		if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
			t.Fatal(err)
		}
		defer s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": id})
		defer s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": id})
		insert := func(name, sha string) {
			t.Helper()
			if _, err := s.Store.DB.Collection("files").InsertOne(ctx, M{"repoId": id, "treeGeneration": "fixture", "path": "", "name": name, "size": 1, "sha": sha}); err != nil {
				t.Fatal(err)
			}
		}
		// Reverse insertion order to prove collision selection uses path/name order.
		insert("bob.txt", "bob")
		insert("alice.txt", "alice")
		lookup := func(requested, want string) {
			t.Helper()
			row, err := s.indexedFile(ctx, repo, requested)
			if err != nil || str(row["sha"]) != want {
				t.Fatal(requested, row, err, want)
			}
		}
		lookup("shared.txt", "alice")
		lookup("bob.txt", "bob")
		insert("shared.txt", "exact")
		lookup("shared.txt", "exact")
		if _, err := s.Store.DB.Collection("files").DeleteOne(ctx, M{"repoId": id, "name": "shared.txt"}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.DB.Collection("files").UpdateOne(ctx, M{"repoId": id, "name": "alice.txt"}, M{"$set": M{"sha": "updated"}}); err != nil {
			t.Fatal(err)
		}
		// The unchanged revision retains its snapshot; a revision change rebuilds it.
		lookup("shared.txt", "alice")
		repo["fileMetadataRevision"] = "second"
		if _, err := s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": M{"fileMetadataRevision": "second"}}); err != nil {
			t.Fatal(err)
		}
		lookup("shared.txt", "updated")
		repo["source"] = M{"provider": "fixture", "commit": "new"}
		if _, err := s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": M{"source.provider": "fixture", "source.commit": "new"}}); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Store.DB.Collection("files").UpdateOne(ctx, M{"repoId": id, "name": "alice.txt"}, M{"$set": M{"sha": "new-commit"}}); err != nil {
			t.Fatal(err)
		}
		lookup("shared.txt", "new-commit")
		key := "test-path-index-" + bson.NewObjectID().Hex()
		defer s.Store.Redis.Del(ctx, key, key+":lock", key+":stale")
		if err := s.Store.Redis.Set(ctx, key+":lock", "new-owner", time.Minute).Err(); err != nil {
			t.Fatal(err)
		}
		if err := s.buildPathIndex(ctx, repo, key, "stale"); err == nil || err.Error() != "path_index_busy" {
			t.Fatal("expired builder published", err)
		}
		if exists, err := s.Store.Redis.Exists(ctx, key).Result(); err != nil || exists != 0 {
			t.Fatal(exists, err)
		}
		for _, change := range []M{
			{"fileMetadataRevision": "retired"},
			{"treeGeneration": "new-tree"},
			{"options.terms": []string{"changed"}},
			{"source.commit": "changed"},
			{"contentCacheRevision": "changed"},
			{"providerAccess.revision": "changed"},
			{"status": "archived"},
		} {
			if _, err := s.Store.DB.Collection(collection("repo")).ReplaceOne(ctx, M{"repoId": id}, repo); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": change}); err != nil {
				t.Fatal(err)
			}
			for _, requested := range []string{"bob.txt", "shared.txt"} {
				if row, err := s.indexedFile(ctx, repo, requested); err == nil || err.Error() != "repository_changed" || row != nil {
					t.Fatal("stale lookup", change, requested, row, err)
				}
			}
		}
		if _, err := s.Store.DB.Collection(collection("repo")).ReplaceOne(ctx, M{"repoId": id}, repo); err != nil {
			t.Fatal(err)
		}
		// Queue a builder behind the concurrency gate, then retire its metadata.
		for i := 0; i < cap(s.pathBuilds); i++ {
			s.pathBuilds <- struct{}{}
		}
		buildKey := "test-stale-build-" + bson.NewObjectID().Hex()
		defer s.Store.Redis.Del(ctx, buildKey, buildKey+":lock", buildKey+":owner")
		if err := s.Store.Redis.Set(ctx, buildKey+":lock", "owner", time.Minute).Err(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- s.buildPathIndex(ctx, repo, buildKey, "owner") }()
		_, updateErr := s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": M{"fileMetadataRevision": "retired-during-build"}})
		for i := 0; i < cap(s.pathBuilds); i++ {
			<-s.pathBuilds
		}
		if updateErr != nil {
			t.Fatal(updateErr)
		}
		if err := <-done; err == nil || err.Error() != "repository_changed" {
			t.Fatal("retired builder succeeded", err)
		}
		if exists, err := s.Store.Redis.Exists(ctx, buildKey, buildKey+":owner").Result(); err != nil || exists != 0 {
			t.Fatal("retired build remains visible", exists, err)
		}

	})
}
