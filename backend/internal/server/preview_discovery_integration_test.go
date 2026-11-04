package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
)

func runPreviewDiscoveryIntegration(t *testing.T, base *Server) {
	t.Run("GitHub branch and README preview caches retain authorization and commits", func(t *testing.T) {
		ctx := context.Background()
		owner, key := bson.NewObjectID(), bson.NewObjectID()
		db := base.Store.DB.Client().Database("preview_discovery_" + owner.Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		s.Config.AppEnabled = false
		registry, err := provider.New(&githubProvider{s})
		if err != nil {
			t.Fatal(err)
		}
		s.providers = registry
		user := M{"_id": owner, "username": "owner", "status": "active"}
		if _, err := db.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Collection("repositories").InsertOne(ctx, M{"_id": key, "externalId": "gh_42", "source": "github", "name": "team/project", "defaultBranch": "main", "branches": []M{}}); err != nil {
			t.Fatal(err)
		}
		q := &request{Server: s, R: httptest.NewRequest("GET", "/", nil), Params: map[string]string{"owner": "team", "repo": "project"}, User: user, Identity: identity(user)}
		if err := s.saveGrant(q, owner, "github", M{"access_token": "synthetic-oauth"}); err != nil {
			t.Fatal(err)
		}
		repoCalls, branchCalls, readmeCalls := 0, 0, 0
		repoStatus, branchStatus, readmeStatus := 200, 200, 200
		emptyBranches := false
		defaultBranch, branchName, sha, content := "main", "main", strings.Repeat("a", 40), "first README"
		requestedRef := ""
		var duringReadme, duringBranches func()
		var readmeOverride M
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			if r.Header.Get("Authorization") != "Bearer synthetic-oauth" {
				t.Fatal("wrong preview credential")
			}
			status := 200
			var data any
			switch r.URL.Path {
			case "/repos/team/project":
				repoCalls++
				status = repoStatus
				data = M{"id": 42, "full_name": "team/project", "default_branch": defaultBranch}
			case "/repos/team/project/branches":
				branchCalls++
				status = branchStatus
				data = []M{{"name": branchName, "commit": M{"sha": sha}}}
				if emptyBranches {
					data = []M{}
				}
				if duringBranches != nil {
					duringBranches()
				}
			case "/repos/team/project/readme":
				readmeCalls++
				status = readmeStatus
				requestedRef = r.URL.Query().Get("ref")
				data = M{"encoding": "base64", "content": base64.StdEncoding.EncodeToString([]byte(content))}
				if readmeOverride != nil {
					data = readmeOverride
				}
				if duringReadme != nil {
					duringReadme()
				}
			default:
				t.Fatal("unexpected preview endpoint", r.URL)
			}
			b, _ := json.Marshal(data)
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(b)))}, nil
		})}
		call := func(mode, query string) (any, string, error) {
			before := repoCalls
			q.R = httptest.NewRequest("GET", "/"+query, nil)
			w := httptest.NewRecorder()
			q.W = w
			result, err := s.sourceRepository(mode)(q)
			if repoCalls != before+1 {
				t.Fatal("cached discovery skipped upstream access check")
			}
			return result, w.Body.String(), err
		}
		branches, _, err := call("branches", "")
		if err != nil || branchCalls != 1 || len(branches.([]M)) != 1 {
			t.Fatal("cold branches failed", branches, err)
		}
		if _, _, err = call("branches", ""); err != nil || branchCalls != 1 {
			t.Fatal("branches not cached", branchCalls, err)
		}
		_, body, err := call("readme", "")
		if err != nil || body != content || readmeCalls != 1 || requestedRef != sha || branchCalls != 1 {
			t.Fatal("README not resolved at cached commit", body, requestedRef, err)
		}
		if _, body, err = call("readme", ""); err != nil || body != content || readmeCalls != 1 {
			t.Fatal("README cache missed", body, err)
		}

		for _, query := range []string{"?branch[]=main", "?branch[0]=main", "?branch=main", "?branch="} {
			if _, body, err = call("readme", query); err != nil || body != content || readmeCalls != 1 {
				t.Fatal(query, body, err)
			}
		}
		for _, query := range []string{"?branch[]=", "?branch=main&branch=missing"} {
			if _, _, err = call("readme", query); err == nil || err.Error() != "readme_not_available" || readmeCalls != 1 {
				t.Fatal(query, err)
			}
		}
		branches, _, err = call("branches", "")
		if err != nil || branches.([]M)[0]["readme"] != content {
			t.Fatal("branch output omitted cached README", branches, err)
		}
		sha = strings.Repeat("b", 40)
		content = "second README"
		branches, _, err = call("branches", "?force[]=1")
		if err != nil || branches.([]M)[0]["commit"] != sha || branches.([]M)[0]["readme"] != "first README" || branchCalls != 2 {
			t.Fatal("forced branches lost README by name", branches, err)
		}
		if _, body, err = call("readme", "?force=1"); err != nil || body != content || requestedRef != sha || readmeCalls != 2 || branchCalls != 3 {
			t.Fatal("forced README did not refresh branch and content", body, err)
		}
		content = ""
		if _, _, err = call("readme", "?force=1"); err != nil {
			t.Fatal(err)
		}
		before := readmeCalls
		if _, body, err = call("readme", ""); err != nil || body != "" || readmeCalls != before+1 {
			t.Fatal("empty README must be fetched again", body, err)
		}
		before = readmeCalls
		if _, _, err = call("readme", "?branch=missing"); err == nil || err.Error() != "readme_not_available" || readmeCalls != before {
			t.Fatal("missing branch fetched README", err)
		}
		defaultBranch, branchName = "", "master"
		sha = strings.Repeat("c", 40)
		content = "master README"
		if _, body, err = call("readme", "?force=1"); err != nil || body != content || requestedRef != sha {
			t.Fatal("master fallback failed", body, err)
		}
		branchStatus = 503
		_, _, err = call("branches", "?force=1")
		var api *APIError
		if !errors.As(err, &api) || api.Code != "repo_not_found" || api.Status != 503 {
			t.Fatal("branch error differs", err)
		}
		branchStatus = 200
		readmeStatus = 503
		if _, _, err = call("readme", "?force=1"); err == nil || err.Error() != "readme_not_available" {
			t.Fatal("README error differs", err)
		}
		readmeStatus = 200
		repoStatus = 403
		before = readmeCalls
		for _, query := range []string{"", "?branch[]=main", "?branch[]="} {
			if _, body, err = call("readme", query); err == nil || body != "" || readmeCalls != before {
				t.Fatal("cached private README bypassed denial", query, body, err)
			}
		}
		repoStatus = 200
		content = "late README"
		newer := strings.Repeat("d", 40)
		duringReadme = func() {
			if _, err := s.Store.update(ctx, "repositories", M{"_id": key}, M{"$set": M{"branches": []M{{"name": "master", "commit": newer, "readme": "newer README"}}, "goDiscoveryRevision": "concurrent-readme"}}); err != nil {
				t.Fatal(err)
			}
		}
		if _, body, err = call("readme", "?force=1"); err != nil || body != "late README" {
			t.Fatal("inflight README failed", body, err)
		}
		duringReadme = nil
		cached, err := s.Store.one(ctx, "repositories", M{"_id": key})
		if err != nil || obj(arr(cached["branches"])[0])["readme"] != "newer README" || obj(arr(cached["branches"])[0])["commit"] != newer {
			t.Fatal("late README replaced newer branch", cached, err)
		}
		newest := strings.Repeat("f", 40)
		sha = strings.Repeat("e", 40)
		duringBranches = func() {
			if _, err := s.Store.update(ctx, "repositories", M{"_id": key}, M{"$set": M{"branches": []M{{"name": "master", "commit": newest, "readme": "newest README"}}, "goDiscoveryRevision": "concurrent-branches"}}); err != nil {
				t.Fatal(err)
			}
		}
		if _, _, err = call("branches", "?force=1"); err != nil {
			t.Fatal(err)
		}
		duringBranches = nil
		cached, err = s.Store.one(ctx, "repositories", M{"_id": key})
		if err != nil || obj(arr(cached["branches"])[0])["commit"] != newest || obj(arr(cached["branches"])[0])["readme"] != "newest README" {
			t.Fatal("late branch refresh overwrote newer cache", cached, err)
		}
		for _, test := range []struct {
			data M
			want string
		}{
			{M{"encoding": "base64", "content": "SG Vs!bG8"}, "Hello"},
			{M{"encoding": "base64", "content": "4oI="}, "\ufffd"},
			{M{"encoding": "hex", "content": "61ff62"}, "a\ufffdb"},
			{M{"encoding": "utf8", "content": "README é"}, "README é"},
		} {
			readmeOverride = test.data
			if _, body, err = call("readme", "?force=1"); err != nil || body != test.want {
				t.Fatal("decoded README response", body, err)
			}
			before := readmeCalls
			if _, body, err = call("readme", ""); err != nil || body != test.want || readmeCalls != before {
				t.Fatal("decoded README cache", body, err)
			}
			branches, _, err = call("branches", "")
			if err != nil || branches.([]M)[0]["readme"] != test.want {
				t.Fatal("decoded README branch output", branches, err)
			}
		}
		for _, invalid := range []M{{"encoding": "unknown", "content": "text"}, {"encoding": "base64", "content": nil}, {"content": M{"length": float64(maxReadmeBytes + 1)}}} {
			readmeOverride = invalid
			_, _, err = call("readme", "?force=1")
			var api *APIError
			if !errors.As(err, &api) || api.Code != "readme_not_available" || api.Status != 404 {
				t.Fatal("README decode error contract", err)
			}
			if _, body, err = call("readme", ""); err != nil || body != "README é" {
				t.Fatal("failed decode damaged cache", body, err)
			}
		}

		raw, err := os.ReadFile("testdata/preview-branch-order.json")
		if err != nil {
			t.Fatal(err)
		}
		var contracts []struct {
			Mode, Query, Error string
			Status             int
			Calls              []string
		}
		if err = json.Unmarshal(raw, &contracts); err != nil {
			t.Fatal(err)
		}
		for _, row := range contracts {
			emptyBranches = row.Mode == "empty"
			branchStatus = 200
			if row.Mode == "failure" {
				branchStatus = 503
			}
			beforeBranches, beforeReadmes := branchCalls, readmeCalls
			_, body, err := call("readme", "?force=1&"+row.Query)
			status := 500
			var api *APIError
			if errors.As(err, &api) {
				status = api.Status
			}
			if err == nil || err.Error() != row.Error || status != row.Status || body != "" || branchCalls != beforeBranches+1 || readmeCalls != beforeReadmes {
				t.Fatal(row, body, err, status, branchCalls-beforeBranches, readmeCalls-beforeReadmes)
			}
		}

	})
}
