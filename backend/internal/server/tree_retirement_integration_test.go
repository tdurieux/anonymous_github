package server

import (
	"context"
	"go.mongodb.org/mongo-driver/v2/bson"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func runTreeRetirementIntegration(t *testing.T, s *Server, p *fixtureProvider, call func(string, string, string, any) *httptest.ResponseRecorder, source M) {
	ctx := context.Background()
	t.Run("tree leases legacy retirement and late inserts", func(t *testing.T) {
		id := "retirement-fixture"
		now := time.Now()
		r := M{"_id": bson.NewObjectID(), "repoId": id, "status": "ready", "treeGeneration": "active", "retiredTreeGenerations": []string{"", "retired", "active"}, "stagedFileTrees": []M{{"generation": "expired", "until": now.Add(-time.Minute)}, {"generation": "live", "until": now.Add(time.Hour)}}}
		if _, e := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); e != nil {
			t.Fatal(e)
		}
		for _, g := range []string{"", "retired", "active", "expired", "live"} {
			row := M{"repoId": id, "name": g + "file", "path": "", "size": 1}
			if g != "" {
				row["treeGeneration"] = g
				row["treeStaged"] = true
			}
			if _, e := s.Store.DB.Collection("files").InsertOne(ctx, row); e != nil {
				t.Fatal(e)
			}
		}
		if e := s.cleanupRepositoryTrees(ctx, r); e != nil {
			t.Fatal(e)
		}
		if ok, e := s.Store.update(ctx, collection("repo"), treePublicationFilter(r, "expired", time.Now()), M{"$set": M{"treeGeneration": "expired"}}); e != nil || ok {
			t.Fatal("retired lease published", ok, e)
		}
		if ok, e := s.Store.update(ctx, collection("repo"), treePublicationFilter(r, "live", time.Now()), M{"$set": M{"testLease": "valid"}}); e != nil || !ok {
			t.Fatal("live lease rejected", ok, e)
		}
		// The late write occurs after its stage and retirement record were removed.
		if _, e := s.Store.DB.Collection("files").InsertOne(ctx, M{"repoId": id, "treeGeneration": "expired", "treeStaged": true, "name": "late", "path": ""}); e != nil {
			t.Fatal(e)
		}
		s.cleanupTrees(ctx)
		rows, e := s.Store.list(ctx, "files", M{"repoId": id}, 100, nil)
		if e != nil || len(rows) != 2 {
			t.Fatal("wrong retained rows", rows, e)
		}
		for _, row := range rows {
			switch str(row["treeGeneration"]) {
			case "active":
				if row["treeStaged"] != nil {
					t.Fatal("active publication marker retained", row)
				}
			case "live":
				if !boolean(row["treeStaged"]) {
					t.Fatal("live stage marker removed", row)
				}
			default:
				t.Fatal("retired row retained", row)
			}
		}
	})
	t.Run("missing branch retires tree without treating revoked access as deletion", func(t *testing.T) {
		r := M{}
		for k, v := range source {
			r[k] = v
		}
		r["_id"] = bson.NewObjectID()
		r["repoId"] = "missing-branch"
		r["status"] = "ready"
		r["treeGeneration"] = "old-branch-tree"
		r["lastView"] = time.Now().Add(-48 * time.Hour)
		r["options"] = M{"expirationMode": "never", "update": true, "terms": []string{}}
		if _, e := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); e != nil {
			t.Fatal(e)
		}
		if _, e := s.Store.DB.Collection("files").InsertOne(ctx, M{"repoId": r["repoId"], "treeGeneration": "old-branch-tree", "name": "old.txt", "path": "", "size": 1}); e != nil {
			t.Fatal(e)
		}
		cachedPath := contentPrefix(r) + "/old.txt"
		if e := s.content.Put(ctx, str(r["repoId"]), cachedPath, strings.NewReader("data"), 4, 4); e != nil {
			t.Fatal(e)
		}
		defer func() { p.revoked = false; p.missingBranch = false }()
		p.revoked = true
		w := call("GET", "/api/repo/missing-branch/options", "", nil)
		if w.Code != 403 {
			t.Fatal(w.Code, w.Body)
		}
		current, e := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if e != nil || str(current["status"]) != "ready" {
			t.Fatal("access error destroyed repository", current, e)
		}
		p.revoked = false
		p.missingBranch = true
		w = call("GET", "/api/repo/missing-branch/options", "", nil)
		if w.Code != 404 {
			t.Fatal(w.Code, w.Body)
		}
		current, e = s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if e != nil || str(current["status"]) != "error" || str(current["statusMessage"]) != "branch_not_found" || number(obj(current["size"])["file"]) != 0 {
			t.Fatal("branch failure not persisted", current, e)
		}
		body, readErr := s.content.Read(ctx, str(r["repoId"]), cachedPath)
		if body != nil {
			body.Close()
		}
		if readErr == nil {
			t.Fatal("missing branch cache retained")
		}
		rows, e := s.Store.list(ctx, "files", M{"repoId": r["repoId"]}, 100, nil)
		if e != nil || len(rows) != 0 {
			t.Fatal("old tree survived missing branch", rows, e)
		}
	})
}

func runContentRetirementIntegration(t *testing.T, s *Server) {
	t.Run("retired content and legacy cleanup preserve current data and ZIP sources", func(t *testing.T) {
		ctx := context.Background()
		r := M{"_id": bson.NewObjectID(), "repoId": "content-retirement", "status": "ready", "treeGeneration": "current", "anonymizeDate": time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), "source": M{"type": "GitHubStream"}, "legacyContentCleanupPending": true}
		active := contentPrefix(r)
		retired := "__content/" + strings.Repeat("a", 64)
		r["retiredContentPrefixes"] = []string{retired, active, "../../outside"}
		if _, e := s.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); e != nil {
			t.Fatal(e)
		}
		paths := []string{active + "/current.txt", retired + "/old.txt", "legacy.txt", "__content/invalid/file.txt"}
		for _, path := range paths {
			if e := s.content.Put(ctx, str(r["repoId"]), path, strings.NewReader("data"), 4, 4); e != nil {
				t.Fatal(e)
			}
		}
		if e := s.cleanupContent(ctx, r); e != nil {
			t.Fatal(e)
		}
		for _, path := range paths {
			body, e := s.content.Read(ctx, str(r["repoId"]), path)
			if body != nil {
				body.Close()
			}
			if path == paths[0] {
				if e != nil {
					t.Fatal("active content removed", e)
				}
			} else if e == nil {
				t.Fatal("retired or legacy content retained", path)
			}
		}
		marker := "__content/__retired/" + strings.Repeat("a", 64) + ".txt"
		body, e := s.content.Read(ctx, str(r["repoId"]), marker)
		if e != nil {
			t.Fatal("retirement fence absent", e)
		}
		body.Close()
		current, e := s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if e != nil || current["legacyContentCleanupPending"] != nil {
			t.Fatal("legacy cleanup not acknowledged", current, e)
		}
		archive := M{"_id": bson.NewObjectID(), "repoId": "archive-retirement", "status": "ready", "source": M{"type": "Zip"}, "legacyContentCleanupPending": true, "retiredContentPrefixes": []string{retired}}
		if _, e = s.Store.DB.Collection(collection("repo")).InsertOne(ctx, archive); e != nil {
			t.Fatal(e)
		}
		if e = s.content.Put(ctx, str(archive["repoId"]), "source.txt", strings.NewReader("data"), 4, 4); e != nil {
			t.Fatal(e)
		}
		if e = s.cleanupContent(ctx, archive); e != nil {
			t.Fatal(e)
		}
		body, e = s.content.Read(ctx, str(archive["repoId"]), "source.txt")
		if e != nil {
			t.Fatal("ZIP source deleted", e)
		}
		body.Close()
	})
}
