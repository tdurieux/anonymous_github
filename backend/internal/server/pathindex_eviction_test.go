package server

import (
	"context"
	"fmt"
	"testing"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
)

type pathReadHook struct {
	before func(context.Context, string) error
}

func (h *pathReadHook) DialHook(next redis.DialHook) redis.DialHook { return next }
func (h *pathReadHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
func (h *pathReadHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if cmd.Name() == "hmget" {
			if err := h.before(ctx, fmt.Sprint(cmd.Args()[1])); err != nil {
				return err
			}
		}
		return next(ctx, cmd)
	}
}

func runPathIndexEvictionIntegration(t *testing.T, s *Server) {
	t.Run("content path index cache eviction", func(t *testing.T) {
		for _, mode := range []string{"once", "always", "missing", "retired"} {
			t.Run(mode, func(t *testing.T) {
				ctx := t.Context()
				id := "path-eviction-" + bson.NewObjectID().Hex()
				repo := M{"_id": bson.NewObjectID(), "repoId": id, "status": "ready", "treeGeneration": "fixture", "options": M{"terms": []string{"alice => shared"}}}
				if _, err := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, repo); err != nil {
					t.Fatal(err)
				}
				defer s.Store.DB.Collection(collection("repo")).DeleteOne(ctx, M{"repoId": id})
				defer s.Store.DB.Collection("files").DeleteMany(ctx, M{"repoId": id})
				if _, err := s.Store.DB.Collection("files").InsertOne(ctx, M{"repoId": id, "treeGeneration": "fixture", "path": "", "name": "alice.txt", "sha": "original", "size": 1}); err != nil {
					t.Fatal(err)
				}
				client := redis.NewClient(s.Store.Redis.Options())
				defer client.Close()
				reads := 0
				key := ""
				defer func() {
					if key != "" {
						s.Store.Redis.Del(ctx, key, key+":lock")
					}
				}()
				client.AddHook(&pathReadHook{before: func(ctx context.Context, k string) error {
					key = k
					reads++
					if reads == 1 || mode == "always" {
						if err := s.Store.Redis.Del(ctx, key).Err(); err != nil {
							return err
						}
					}
					if mode == "retired" {
						_, err := s.Store.DB.Collection(collection("repo")).UpdateOne(ctx, M{"repoId": id}, M{"$set": M{"fileMetadataRevision": "retired"}})
						return err
					}
					return nil
				}})
				isolated := &Server{Config: s.Config, Store: &Store{DB: s.Store.DB, Redis: client}, providers: s.providers, pathBuilds: s.pathBuilds}
				requested := "shared.txt"
				if mode == "missing" {
					requested = "missing.txt"
				}
				row, err := isolated.indexedFile(ctx, repo, requested)
				if mode == "once" {
					if err != nil || row["sha"] != "original" || reads != 2 {
						t.Fatal("eviction lost existing file", row, err, reads)
					}
					return
				}
				want, status := "path_index_busy", 503
				if mode == "missing" {
					want, status = "file_not_found", 404
				}
				if mode == "retired" {
					want, status = "repository_changed", 409
				}
				api, ok := err.(*APIError)
				if !ok || api.Code != want || api.Status != status || row != nil {
					t.Fatal(mode, row, err, want)
				}
				if reads > 2 {
					t.Fatal("unbounded cache rebuild", reads)
				}
			})
		}
	})
}
