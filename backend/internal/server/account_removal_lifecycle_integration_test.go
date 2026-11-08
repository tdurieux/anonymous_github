package server

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/storage"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAccountRemovalLifecycleIntegration(t *testing.T, base *Server) {
	t.Run("account removal waits for cleanup and remains retryable", func(t *testing.T) {
		ctx := context.Background()
		owner, other := bson.NewObjectID(), bson.NewObjectID()
		prefix := "account-lifecycle-" + owner.Hex()
		db := base.Store.DB.Client().Database("account_lifecycle_" + owner.Hex())
		defer db.Drop(context.Background())
		root := t.TempDir()
		content, err := storage.New(storage.Config{Root: root})
		if err != nil {
			t.Fatal(err)
		}
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}, content: content}
		s.Config.AppEnabled = false
		defer func() { s.content.Close() }()
		user := M{"_id": owner, "username": prefix, "status": "active", "externalIDs": M{"github": prefix}, "apiTokens": []M{{"tokenHash": "synthetic-account-token"}}}
		if _, err := db.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		q := &request{Server: s, User: user, Identity: identity(user), SessionID: prefix, R: httptest.NewRequest("DELETE", "/api/user", nil), W: httptest.NewRecorder()}
		if err := s.saveGrant(q, owner, "github", M{"access_token": "synthetic-account-lifecycle-grant"}); err != nil {
			t.Fatal(err)
		}
		sessionKey := "anoGH_session:" + q.SessionID
		if err := s.Store.Redis.Set(ctx, sessionKey, "fixture-session", time.Minute).Err(); err != nil {
			t.Fatal(err)
		}
		defer s.Store.Redis.Del(context.Background(), sessionKey)
		for _, state := range []string{"archived", "ready", "foreign"} {
			id := prefix + "-" + state
			row := M{"_id": bson.NewObjectID(), "repoId": id, "owner": owner, "status": state, "source": M{"provider": "fixture"}}
			if state == "foreign" {
				row["owner"] = other
				row["status"] = "ready"
				row["coauthors"] = []M{{"username": "renamed", "githubId": prefix}}
			}
			if _, err := db.Collection(collection("repo")).InsertOne(ctx, row); err != nil {
				t.Fatal(err)
			}
			if err := content.Put(ctx, id, "file", strings.NewReader("private"), 7, 7); err != nil {
				t.Fatal(err)
			}
			for _, coll := range []string{"files", "anonymizedpaths"} {
				if _, err := db.Collection(coll).InsertOne(ctx, M{"repoId": id, "path": "file"}); err != nil {
					t.Fatal(err)
				}
			}
		}
		for _, kind := range []string{"pr", "gist"} {
			row := M{"_id": bson.NewObjectID(), idKey(kind): prefix + "-" + kind, "owner": owner, "status": "ready", "source": M{"provider": "fixture"}}
			if kind == "pr" {
				row["pullRequest"] = M{"body": "private body", "title": "private title", "diff": "private diff"}
			} else {
				row["gist"] = M{"description": "private description", "ownerLogin": "private owner", "files": []M{{"content": "private"}}}
			}
			if _, err := db.Collection(collection(kind)).InsertOne(ctx, row); err != nil {
				t.Fatal(err)
			}
		}
		revocations := 0
		s.HTTP = &http.Client{Transport: roundTrip(func(req *http.Request) (*http.Response, error) {
			revocations++
			for _, kind := range []string{"repo", "pr", "gist"} {
				count, err := db.Collection(collection(kind)).CountDocuments(ctx, M{"owner": owner, "status": M{"$ne": "removed"}})
				if err != nil || count != 0 {
					t.Error("revoked grant before content cleanup", kind, count, err)
				}
			}
			return &http.Response{StatusCode: 204, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
		})}
		assertRetryable := func() {
			t.Helper()
			saved, err := s.Store.one(ctx, "users", M{"_id": owner})
			if err != nil || saved["status"] != "active" || saved["username"] != prefix {
				t.Fatal("failed deletion disabled account", err)
			}
			count, err := db.Collection("credentials").CountDocuments(ctx, M{"ownerId": owner})
			if err != nil || count != 1 || revocations != 0 {
				t.Fatal("failed deletion revoked credentials", count, err)
			}
			if count, err := s.Store.Redis.Exists(ctx, sessionKey).Result(); err != nil || count != 1 {
				t.Fatal("failed deletion cleared session", err)
			}
		}
		if result, err := s.deleteAccount(q); err == nil || err.Error() != "repository_archived" || result != nil {
			t.Fatal("archived repository not protected", result, err)
		}
		assertRetryable()
		if _, err := s.Store.update(ctx, collection("repo"), M{"repoId": prefix + "-archived"}, M{"$set": M{"status": "ready"}}); err != nil {
			t.Fatal(err)
		}
		content.Close()
		if result, err := s.deleteAccount(q); err == nil || result != nil {
			t.Fatal("storage failure reported success")
		}
		assertRetryable()
		if count, err := db.Collection(collection("repo")).CountDocuments(ctx, M{"owner": owner, "status": "removing"}); err != nil || count == 0 {
			t.Fatal("failed cleanup lost durable removing state", err)
		}
		s.content, err = storage.New(storage.Config{Root: root})
		if err != nil {
			t.Fatal(err)
		}
		if result, err := s.deleteAccount(q); err != nil || obj(result)["status"] != "ok" {
			t.Fatal("cleanup retry failed", err)
		}
		if revocations != 1 {
			t.Fatal("unexpected revocations", revocations)
		}
		for _, state := range []string{"archived", "ready"} {
			id := prefix + "-" + state
			for _, coll := range []string{"files", "anonymizedpaths"} {
				count, err := db.Collection(coll).CountDocuments(ctx, M{"repoId": id})
				if err != nil || count != 0 {
					t.Fatal("index cleanup incomplete", coll, count, err)
				}
			}
			entries, err := s.content.List(ctx, id)
			if err != nil && !errors.Is(err, fs.ErrNotExist) || len(entries) != 0 {
				t.Fatal("content cleanup incomplete", err)
			}
		}
		foreign, err := s.Store.one(ctx, collection("repo"), M{"repoId": prefix + "-foreign"})
		if err != nil || foreign["status"] != "ready" {
			t.Fatal("coauthor-only resource removed", err)
		}
		if entries, err := s.content.List(ctx, prefix+"-foreign"); err != nil || len(entries) != 1 {
			t.Fatal("coauthor-only storage changed", err)
		}
		pr, err := s.Store.one(ctx, collection("pr"), M{"owner": owner})
		if err != nil || str(obj(pr["pullRequest"])["body"]) != "" || str(obj(pr["pullRequest"])["diff"]) != "" {
			t.Fatal("PR payload retained", err)
		}
		gist, err := s.Store.one(ctx, collection("gist"), M{"owner": owner})
		if err != nil || len(arr(obj(gist["gist"])["files"])) != 0 || str(obj(gist["gist"])["description"]) != "" {
			t.Fatal("gist payload retained", err)
		}
		saved, err := s.Store.one(ctx, "users", M{"_id": owner})
		if err != nil || saved["status"] != "removed" {
			t.Fatal("account not removed after cleanup", err)
		}
	})
}
