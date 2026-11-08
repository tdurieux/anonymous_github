package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/event"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func runConnectionsSummaryIntegration(t *testing.T, base *Server) {
	t.Run("connection summary retains all GitHub resources across providers", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		db := base.Store.DB.Client().Database("connections_summary_" + owner.Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		s.Config.AppEnabled = false
		user := M{"_id": owner, "username": owner.Hex(), "status": "active"}
		if _, err := db.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		q := &request{Server: s, User: user, Session: M{"githubConnectionCSRF": "synthetic-csrf"}, SessionID: "connections-" + owner.Hex(), R: httptest.NewRequest("GET", "/github/connections", nil), W: httptest.NewRecorder()}
		defer s.Store.Redis.Del(ctx, "anoGH_session:"+q.SessionID)
		for i := 0; i < 12; i++ {
			if _, err := db.Collection("credentials").InsertOne(ctx, M{"ownerId": owner, "provider": fmt.Sprintf("other-forge-%d", i), "encryptedToken": "not-a-GitHub-envelope"}); err != nil {
				t.Fatal(err)
			}
		}
		for _, provider := range []string{"github", "github-app-user"} {
			tokens := M{"access_token": "synthetic-token", "refresh_token": "synthetic-refresh", "expires_in": float64(3600), "refresh_token_expires_in": float64(7200)}
			if err := s.saveGrant(q, owner, provider, tokens); err != nil {
				t.Fatal(err)
			}
		}
		// TypeScript's OAuth connection indicator reads the stored token regardless of revoked state.
		if _, err := s.Store.update(ctx, "credentials", M{"ownerId": owner, "provider": "github"}, M{"$set": M{"revoked": true}}); err != nil {
			t.Fatal(err)
		}
		const count = 10001
		for _, kind := range []string{"repo", "pr"} {
			records := make([]any, 0, count+3)
			for i := 0; i < count; i++ {
				records = append(records, M{idKey(kind): fmt.Sprintf("%s-%d", kind, i), "owner": owner, "source": M{"provider": "github", "repositoryName": "team/repo", "repositoryFullName": "team/repo"}, "status": "ready", "statusDate": time.Now()})
			}
			for _, extra := range []string{"other-provider", "removed", "other-owner"} {
				row := M{idKey(kind): extra, "owner": owner, "source": M{"provider": "github"}, "status": "ready"}
				switch extra {
				case "other-provider":
					row["source"] = M{"provider": "fixture"}
				case "removed":
					row["status"] = "removed"
				case "other-owner":
					row["owner"] = bson.NewObjectID()
				}
				records = append(records, row)
			}
			if _, err := db.Collection(collection(kind)).InsertMany(ctx, records); err != nil {
				t.Fatal(err)
			}
		}
		for _, provider := range []string{"github", "fixture"} {
			if _, err := db.Collection(collection("gist")).InsertOne(ctx, M{"owner": owner, "source": M{"provider": provider}, "status": "ready"}); err != nil {
				t.Fatal(err)
			}
		}
		const privateMarker = "synthetic-not-part-of-connection-summary"
		for _, kind := range []string{"repo", "pr"} {
			if _, err := s.Store.update(ctx, collection(kind), M{idKey(kind): kind + "-0"}, M{"$set": M{"privatePayload": strings.Repeat(privateMarker, 32768), "source.accessToken": privateMarker, "githubAccess.privateBinding": privateMarker}}); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := s.Store.update(ctx, "credentials", M{"ownerId": owner, "provider": "github"}, M{"$set": M{"privateMetadata": privateMarker}}); err != nil {
			t.Fatal(err)
		}
		// Observe actual MongoDB replies, not just the already-filtered HTTP result.
		var mu sync.Mutex
		findCount, unprojected, leaked := 0, false, false
		monitor := &event.CommandMonitor{
			Started: func(_ context.Context, e *event.CommandStartedEvent) {
				if e.CommandName != "find" {
					return
				}
				mu.Lock()
				defer mu.Unlock()
				findCount++
				if _, err := e.Command.LookupErr("projection"); err != nil {
					unprojected = true
				}
			},
			Succeeded: func(_ context.Context, e *event.CommandSucceededEvent) {
				if e.CommandName != "find" && e.CommandName != "getMore" {
					return
				}
				if bytes.Contains(e.Reply, []byte(privateMarker)) {
					mu.Lock()
					leaked = true
					mu.Unlock()
				}
			},
		}
		observed, err := mongo.Connect(options.Client().ApplyURI(os.Getenv("GO_TEST_MONGODB_URI")).SetBSONOptions(&options.BSONOptions{DefaultDocumentM: true}).SetMonitor(monitor))
		if err != nil {
			t.Fatal(err)
		}
		defer observed.Disconnect(ctx)
		s.Store.DB = observed.Database(db.Name())
		result, err := s.connections(q)
		s.Store.DB = db
		mu.Lock()
		observedFinds, missingProjection, privatePayloadRead := findCount, unprojected, leaked
		mu.Unlock()
		if observedFinds != 4 || missingProjection || privatePayloadRead {
			t.Fatal("connection summary read unnecessary database payloads", observedFinds, missingProjection, privatePayloadRead)
		}
		if err != nil {
			t.Fatal(err)
		}
		output := obj(result)
		if !boolean(output["oauthConnected"]) || !boolean(output["appConnected"]) || output["gistConnection"] != "oauth" || number(output["gistCount"]) != 1 {
			t.Fatal("provider grants hidden or mixed", output["oauthConnected"], output["appConnected"], output["gistCount"])
		}
		resources := arr(output["resources"])
		if len(resources) != 2*count {
			t.Fatal("resources truncated or foreign records included", len(resources))
		}
		seen := map[string]bool{}
		for _, value := range resources {
			row := obj(value)
			id := str(row["id"])
			if seen[id] || row["name"] != "team/repo" || row["connection"] != "oauth" {
				t.Fatal("wrong resource summary", row)
			}
			seen[id] = true
		}
		if !seen["repo-10000"] || !seen["pr-10000"] {
			t.Fatal("tail resources omitted")
		}
		// Remove bulk fixtures before exercising connection-state variations.
		for _, kind := range []string{"repo", "pr"} {
			if _, err := db.Collection(collection(kind)).DeleteMany(ctx, M{}); err != nil {
				t.Fatal(err)
			}
		}
		s.Config.AppEnabled = true
		s.Config.AppID = "123"
		status := 503
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			if r.URL.Path != "/user/installations" {
				t.Fatal("unexpected upstream request", r.URL)
			}
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"installations":[{"id":42,"app_id":123,"account":{"login":"team"},"suspended_at":""}]}`))}, nil
		})}
		result, err = s.connections(q)
		if err != nil || obj(result)["appError"] != "github_unavailable" {
			t.Fatal("upstream error hidden", result, err)
		}
		status = 200
		result, err = s.connections(q)
		if err != nil {
			t.Fatal(err)
		}
		output = obj(result)
		if output["gistConnection"] != "github-app" || output["appError"] != nil || len(arr(output["installations"])) != 1 || boolean(obj(arr(output["installations"])[0])["suspended"]) {
			t.Fatal("installation output differs", output)
		}
		if _, err := s.Store.update(ctx, "credentials", M{"ownerId": owner, "provider": "github"}, M{"$set": M{"encryptedToken": "broken-envelope"}}); err != nil {
			t.Fatal(err)
		}
		if _, err = s.connections(q); err == nil || err.Error() != "credential_decryption_failed" {
			t.Fatal("invalid stored OAuth token reported connected", err)
		}
	})
}
