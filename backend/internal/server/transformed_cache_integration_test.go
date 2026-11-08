package server

import (
	"context"
	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runTransformedCacheIntegration(t *testing.T, base *Server, p *fixtureProvider) {
	t.Run("transformed output cache", func(t *testing.T) {
		ctx := context.Background()
		original, err := base.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if err != nil {
			t.Fatal(err)
		}
		r := selectFields(original, "owner", "source", "providerAccess", "options")
		r["_id"], r["repoId"], r["status"] = bson.NewObjectID(), "transformed-cache-fixture", "ready"
		r["treeGeneration"], r["anonymizeDate"] = "transform-generation", time.Now().Truncate(time.Millisecond)
		if _, err = base.Store.DB.Collection(collection("repo")).InsertOne(ctx, r); err != nil {
			t.Fatal(err)
		}
		s := &Server{Config: base.Config, Store: base.Store, providers: base.providers, content: base.content, pool: base.pool, cacheMetrics: testCacheMetrics()}
		defer s.pool.RemoveResults(str(r["repoId"]))
		row := M{"path": "", "name": "Alice.txt", "sha": "blob:one", "size": len(fixtureContent)}
		read := func() (string, error) {
			reader, cleanup, text, err := s.transformed(ctx, r, row)
			if err != nil {
				return "", err
			}
			defer cleanup()
			if !text {
				t.Fatal("text output misclassified")
			}
			b, err := io.ReadAll(reader)
			return string(b), err
		}
		first, err := read()
		if err != nil || strings.Contains(first, "Alice") {
			t.Fatal(first, err)
		}
		second, err := read()
		if err != nil || first != second {
			t.Fatal("cache changed output", second, err)
		}
		counts := func() map[string]int64 {
			out := map[string]int64{}
			for k, v := range s.cacheMetrics.pending {
				out[k.name] += v.count
			}
			return out
		}
		if n := counts(); n["legacy_result_miss"] != 1 || n["legacy_result_hit"] != 1 {
			t.Fatal("worker output not reused", n)
		}
		// A provider revision is not a substitute for hashing actual source bytes.
		access, err := s.providerAccess(r)
		if err != nil {
			t.Fatal(err)
		}
		key := rawCachePath(r, access, provider.Entry{Path: "Alice.txt", Revision: "blob:one"})
		replaced := strings.ReplaceAll(fixtureContent, "Alice", "Carol")
		if err = s.content.Put(ctx, str(r["repoId"]), key, strings.NewReader(replaced), int64(len(replaced)), int64(len(replaced))); err != nil {
			t.Fatal(err)
		}
		changed, err := read()
		if err != nil || changed == first || !strings.Contains(changed, "Carol") {
			t.Fatal("actual-content cache collision", changed, err)
		}
		if err = s.content.Put(ctx, str(r["repoId"]), key, strings.NewReader(fixtureContent), int64(len(fixtureContent)), int64(len(fixtureContent))); err != nil {
			t.Fatal(err)
		}
		p.revoked = true
		_, err = read()
		p.revoked = false
		if err == nil || err.Error() != "fixture_access_revoked" {
			t.Fatal("cached result bypassed authorization", err)
		}
		if err = s.resetContentCache(ctx, r); err != nil {
			t.Fatal(err)
		}
		r, err = s.Store.one(ctx, collection("repo"), M{"_id": r["_id"]})
		if err != nil {
			t.Fatal(err)
		}
		third, err := read()
		if err != nil || third != first {
			t.Fatal("reset changed output", third, err)
		}
		if n := counts(); n["legacy_result_miss"] != 3 {
			t.Fatal("reset retained transformed cache", n)
		}
		// Different anonymization settings cannot reuse an old output.
		r["options"] = M{"terms": []string{"hello"}, "link": true}
		stamp := time.Now().Add(time.Second).Truncate(time.Millisecond)
		r["settingsSavedAt"] = stamp
		if _, err = s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"options": r["options"], "settingsSavedAt": stamp}}); err != nil {
			t.Fatal(err)
		}
		fourth, err := read()
		if err != nil || fourth == first || strings.Contains(fourth, "hello") {
			t.Fatal("settings cache collision", fourth, err)
		}
		parallelPool := anonymize.NewPool(os.Getenv("GO_TEST_SERVER_BINARY"), 4)
		defer parallelPool.Close()
		s.pool = parallelPool
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				out, err := read()
				if err != nil || out != fourth {
					t.Errorf("concurrent cached output: %q, %v", out, err)
				}
			}()
		}
		wg.Wait()
		if parallelPool.Stats()["workerStarts"] != uint64(1) {
			t.Fatal("duplicate workers for identical output", parallelPool.Stats())
		}

	})
}
