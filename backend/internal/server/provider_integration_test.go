package server

import (
	"archive/zip"
	"bytes"
	"context"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"io"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Deliberately uses nested namespaces and opaque revisions, unlike GitHub.
type fixtureProvider struct {
	failure        error
	openCount      atomic.Int64
	authorizeCount atomic.Int64
	onOpen         func() (io.ReadCloser, error)
	revoked        bool
	missingBranch  bool
	onMetadata     func(context.Context, provider.Access, string) (*provider.Entry, error)
	onDocument     func()
	onAuthorized   func()
	onRepository   func()
	name, commit   string
}

func (p *fixtureProvider) FileMetadata(ctx context.Context, a provider.Access, path string) (*provider.Entry, error) {
	if p.onMetadata != nil {
		return p.onMetadata(ctx, a, path)
	}
	return nil, nil
}
func (p *fixtureProvider) ID() string { return "fixture" }
func (p *fixtureProvider) Connect(_ context.Context, q provider.ConnectRequest) (provider.Connection, error) {
	return provider.Connection{Ref: provider.Ref{Provider: p.ID(), ID: "project:123", Name: q.Name}, Binding: map[string]any{"provider": p.ID(), "kind": "fixture-grant", "revision": "grant:1"}}, nil
}
func (p *fixtureProvider) Authorize(_ context.Context, a provider.Access) error {
	p.authorizeCount.Add(1)
	if p.revoked || a.Binding["kind"] != "fixture-grant" {
		return fail("fixture_access_revoked", 403)
	}
	if p.onAuthorized != nil {
		p.onAuthorized()
	}
	return nil
}
func (p *fixtureProvider) Repository(context.Context, provider.Access) (provider.Repository, error) {
	if p.failure != nil {
		return provider.Repository{}, p.failure
	}
	if p.onRepository != nil {
		p.onRepository()
	}
	return provider.Repository{ID: "project:123", Name: p.name, URL: "https://forge.test/" + p.name, DefaultBranch: "main"}, nil
}
func (p *fixtureProvider) Commit(context.Context, provider.Access, string) (provider.Commit, error) {
	return provider.Commit{ID: p.commit, Date: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}, nil
}

const fixtureContent = "hello Alice https://forge.test/team/subgroup/project/blob/main/Alice.txt https://github.com/team/subgroup/project"

func (p *fixtureProvider) Tree(context.Context, provider.Access) ([]provider.Entry, error) {
	return []provider.Entry{{Path: "Alice.txt", Revision: "blob:one", Size: int64(len(fixtureContent))}}, nil
}
func (p *fixtureProvider) Open(context.Context, provider.Access, provider.Entry) (io.ReadCloser, error) {
	p.openCount.Add(1)
	if p.onOpen != nil {
		return p.onOpen()
	}
	return io.NopCloser(strings.NewReader(fixtureContent)), nil
}
func (p *fixtureProvider) PublicURL(r provider.Ref) string { return "https://forge.test/" + r.Name }
func (p *fixtureProvider) SelfLinks(r provider.Ref) []string {
	return []string{p.PublicURL(r) + "/blob/" + r.Branch, p.PublicURL(r)}
}
func runProviderIntegration(t *testing.T, s *Server, p *fixtureProvider, call func(string, string, string, any) *httptest.ResponseRecorder, token, otherToken string) {
	ctx := context.Background()
	for _, kind := range []string{"gist", "pr"} {
		source := M{"provider": "fixture", "gistId": "snippet:one", "repositoryFullName": p.name, "pullRequestId": 42}
		body := M{idKey(kind): "fixture-document", "source": source, "terms": []string{"Alice"}, "options": M{"expirationMode": "never", "title": true, "body": true, "content": true}}
		w := call("POST", "/api/"+kind, token, body)
		if w.Code != 200 {
			t.Fatal(kind, w.Code, w.Body)
		}
		r, e := s.Store.one(ctx, collection(kind), M{idKey(kind): "fixture-document"})
		if e != nil {
			t.Fatal(e)
		}
		if str(r["status"]) != "ready" {
			t.Fatal("create returned before publication", r)
		}
		w = call("GET", "/api/"+kind+"/fixture-document/content", "", nil)
		if w.Code != 200 || strings.Contains(w.Body.String(), "Alice") || !strings.Contains(w.Body.String(), "XXXX-1") {
			t.Fatal(kind, w.Code, w.Body)
		}
		w = call("GET", "/api/providers/fixture/"+kind+"/42?name=team/subgroup/project", token, nil)
		if w.Code != 200 {
			t.Fatal("document source", kind, w.Code, w.Body)
		}
	}

	runEmbeddedRefreshIntegration(t, s, p, call, token)
	body := M{"repoId": "second-provider", "fullName": p.name, "source": M{"provider": p.ID(), "branch": "main", "commit": p.commit}, "terms": []string{"Alice"}, "options": M{"expirationMode": "never", "image": true, "pdf": true, "link": true}}
	w := call("POST", "/api/repo", token, body)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	load := func() M {
		t.Helper()
		r, e := s.Store.one(ctx, collection("repo"), M{"repoId": "second-provider"})
		if e != nil || r == nil {
			t.Fatal(r, e)
		}
		return r
	}
	r := load()
	filtered, e := s.Store.list(ctx, collection("repo"), githubSources(M{"_id": r["_id"]}), 10, nil)
	if e != nil || len(filtered) != 0 {
		t.Fatal("provider treated as GitHub OAuth", filtered, e)
	}
	req := httptest.NewRequest("POST", "/github/connections/migrate", nil)
	req.Header.Set("X-CSRF-Token", "test-csrf")
	_, e = s.connections(&request{Server: s, R: req, W: httptest.NewRecorder(), User: M{"_id": r["owner"]}, Session: M{"githubConnectionCSRF": "test-csrf"}, Body: M{"type": "repository", "id": "second-provider", "connection": "oauth"}})
	if e == nil || e.Error() != "repository_busy" {
		t.Fatal("unexpected preparation guard", e)
	}

	if r["githubAccess"] != nil || str(obj(r["source"])["providerRepositoryId"]) != "project:123" {
		t.Fatal("wrong binding", r)
	}
	if e := s.prepareTree(ctx, r); e != nil {
		t.Fatal(e)
	}
	_, e = s.connections(&request{Server: s, R: req, W: httptest.NewRecorder(), User: M{"_id": r["owner"]}, Session: M{"githubConnectionCSRF": "test-csrf"}, Body: M{"type": "repository", "id": "second-provider", "connection": "oauth"}})
	if e == nil || e.Error() != "provider_capability_not_supported" {
		t.Fatal("GitHub migration accepted another provider", e)
	}
	runConditionalResponseIntegration(t, s, p, token, otherToken)
	runRepositoryRecoveryIntegration(t, s, call, token, r)
	runRepositoryRefreshIntegration(t, s, p, call, r)
	runTreeRetirementIntegration(t, s, p, call, r)
	runGitHubBranchIntegration(t, s, r["owner"])
	runGitHubMetadataIntegration(t, s, r["owner"])
	runGitHubPartialTreeIntegration(t, s, r["owner"])
	runContentRetirementIntegration(t, s)
	runRawCacheIntegration(t, s, p)
	runSharedSourceIntegration(t, s, p, call)
	runLegacySourceIntegration(t, s)
	runSharedResultIntegration(t, s, p)
	runSharedHTTPIntegration(t, s, p)
	runSharedFallbackIntegration(t, s, p)
	runFileMetadataIntegration(t, s, p)
	runFileSearchIntegration(t, s)
	runFolderPathIntegration(t, s)
	runPathIndexParityIntegration(t, s)
	runPathIndexEvictionIntegration(t, s)
	runFileRecoveryIntegration(t, s, p)
	runPendingMetadataIntegration(t, s)
	runPartialTreeIntegration(t, s, p)
	runWebsiteLookupIntegration(t, s)
	runFileTreeScanIntegration(t, s)
	runTransformedCacheIntegration(t, s, p)
	runCachePresenceIntegration(t, s, p)
	runRepositoryRemovalIntegration(t, s, token, otherToken)
	runManualRefreshIntegration(t, s, p, call, token, r)
	runExtensionIntegration(t, s, p, call, token, r)
	runDocumentLifecycleIntegration(t, s, p, call, token)
	runValidationIntegration(t, s, p, call, token, otherToken)
	runResourceOptionsDifferentialIntegration(t, s, p, token, otherToken)
	runSettingsLifecycleIntegration(t, s, p, token)
	runProviderErrorsIntegration(t, s, p, token)
	runProviderIdentityIntegration(t, s, p, token)
	runProviderReconnectIntegration(t, s)
	runProviderPreviewIntegration(t, s)
	runProviderHintIntegration(t, s)
	runCacheMetricsIntegration(t, s)
	runCacheReportHTTPIntegration(t, s)
	runPreviewMetadataIntegration(t, s)
	runPreviewDiscoveryIntegration(t, s)
	runDocumentIdentityIntegration(t, s, p, token)
	runConferenceMembershipIntegration(t, s, token, r["owner"])
	runConferenceRecoveryIntegration(t, s, token, r["owner"])
	runConferenceFormIntegration(t, s, token, otherToken, r["owner"])
	runConferenceOptionsIntegration(t, s, token, otherToken, r["owner"])
	runConferenceLifecycleIntegration(t, s, token, r["owner"])
	runConferenceRemovalIntegration(t, s, token, otherToken, r["owner"])
	runAdminFiltersIntegration(t, s, token)
	runAdminCastingIntegration(t, s)
	runUserSearchIntegration(t, s)
	runUserListsIntegration(t, s)
	runUserListCapacityIntegration(t, s)
	runAdminMutationsIntegration(t, s)
	runAdminUserDetailIntegration(t, s, token)
	runUserDefaultsIntegration(t, s)
	runQuotaIntegration(t, s)
	runGrantIntegration(t, s)
	runGrantRevocationIntegration(t, s)
	runWebhookIntegration(t, s)
	runInstallationReconciliationIntegration(t, s)
	runGrantReconciliationIntegration(t, s)
	runConnectionsSummaryIntegration(t, s)
	runConnectionMigrationIntegration(t, s)
	runInstallationFlowIntegration(t, s)
	runOAuthInstallIntegration(t, s)
	runAppProfileIntegration(t, s)
	runAccessSelectionIntegration(t, s)
	runAccessPaginationIntegration(t, s)
	runInstallationTokenIntegration(t, s)
	runConferenceCapacityIntegration(t, s)
	runLegacyGitHubQuotaIntegration(t, s)
	runGitHubQuotaIntegration(t, s)
	runJobRateLimitIntegration(t, s)
	runImportedRemovalIntegration(t, s)
	runJobRetryIntegration(t, s)
	runAdminQueueIntegration(t, s)
	runAccountRemovalIntegration(t, s)
	runAccountRemovalLifecycleIntegration(t, s)
	runDocumentCleanupIntegration(t, s)
	runDiscoveryIntegration(t, s)
	runDiscoveryCacheIntegration(t, s)
	runCoauthorsIntegration(t, s)
	runAdminTokensIntegration(t, s)
	runProjectNamesIntegration(t, s)
	runDashboardNamesIntegration(t, s)
	runDashboardCursorIntegration(t, s)
	runDashboardFiltersIntegration(t, s)
	runOAuthCallbackIntegration(t, s, token)
	runAppRefreshIntegration(t, s)
	for _, route := range []string{"/api/repo/second-provider/files", "/api/repo/second-provider/files/search?q=XX", "/api/repo/second-provider/files/counts"} {
		w = call("GET", route, "", nil)
		if w.Code != 200 || strings.Contains(w.Body.String(), "Alice") {
			t.Fatal(route, w.Code, w.Body)
		}
	}
	w = call("GET", "/api/repo/second-provider", otherToken, nil)
	if w.Code != 403 {
		t.Fatal("private output exposed", w.Code)
	}
	w = call("GET", "/api/repo/second-provider/file/XXXX-1.txt", "", nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "forge.test") || strings.Contains(w.Body.String(), "Alice") || !strings.Contains(w.Body.String(), "https://github.com/team/subgroup/project") {
		t.Fatal("wrong provider self-link", w.Code, w.Body)
	}
	w = call("GET", "/api/repo/second-provider/zip", "", nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	archive, e := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if e != nil || len(archive.File) != 1 {
		t.Fatal("invalid ZIP", e)
	}
	p.revoked = true
	w = call("HEAD", "/api/repo/second-provider/zip", "", nil)
	if w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Disposition") == "" {
		t.Fatal("ZIP HEAD streamed or fetched content", w.Code, w.Body)
	}
	w = call("GET", "/api/repo/second-provider/file/XXXX-1.txt", "", nil)
	if w.Code != 403 {
		t.Fatal("revoked access served content", w.Code, w.Body)
	}
	p.revoked = false
	obj(body["source"])["provider"] = "github"
	w = call("POST", "/api/repo/second-provider", token, body)
	if w.Code != 409 {
		t.Fatal("provider switch accepted", w.Code, w.Body)
	}
	obj(body["source"])["provider"] = "unknown"
	body["repoId"] = "unknown-provider"
	w = call("POST", "/api/repo", token, body)
	if w.Code != 400 {
		t.Fatal("unknown provider accepted", w.Code, w.Body)
	}
	w = call("GET", "/api/providers/fixture/repository/branches?name=team/subgroup/project", token, nil)
	if w.Code != 400 {
		t.Fatal("unsupported capability", w.Code, w.Body)
	}
	r = load()
	p.name = "team/renamed/unchanged"
	_, e = s.Store.update(ctx, collection("repo"), M{"_id": r["_id"]}, M{"$set": M{"options.update": true, "lastView": time.Now().Add(-48 * time.Hour)}})
	if e != nil {
		t.Fatal(e)
	}
	if e = s.autoRefresh(ctx, load()); e != nil {
		t.Fatal(e)
	}
	if got := str(obj(load()["source"])["repositoryName"]); got != p.name {
		t.Fatal("unchanged-commit rename lost", got)
	}
	p.name = "team/renamed/project"
	p.commit = "revision:two"
	if _, e = s.Store.update(ctx, "gojobs", M{"_id": "repo:second-provider:prepare"}, M{"$set": M{"state": "completed", "finishedAt": time.Now()}}); e != nil {
		t.Fatal(e)
	}
	w = call("POST", "/api/repo/second-provider/refresh", token, nil)
	if w.Code != 200 {
		t.Fatal("refresh", w.Code, w.Body)
	}
	r = load()
	if str(obj(r["source"])["repositoryName"]) != p.name || str(obj(r["source"])["commit"]) != p.commit {
		t.Fatal("refresh did not preserve provider", r)
	}
	if e = s.prepareTree(ctx, r); e != nil {
		t.Fatal(e)
	}
	w = call("DELETE", "/api/repo/second-provider", token, nil)
	if w.Code != 200 {
		t.Fatal("remove", w.Code, w.Body)
	}
	if e = s.runJob(ctx, M{"kind": "repo", "resourceId": "second-provider", "action": "remove"}); e != nil {
		t.Fatal(e)
	}
	w = call("GET", "/api/repo/second-provider/file/XXXX-1.txt", "", nil)
	if w.Code != 410 {
		t.Fatal("removed content served", w.Code, w.Body)
	}
}

func (p *fixtureProvider) ConnectDocument(ctx context.Context, q provider.DocumentRequest, connection string) (provider.Access, error) {
	c, e := p.Connect(ctx, provider.ConnectRequest{OwnerID: q.Access.OwnerID, Name: q.Access.Ref.Name, Connection: connection})
	q.Access.Binding = c.Binding
	return q.Access, e
}
func (p *fixtureProvider) Document(ctx context.Context, q provider.DocumentRequest) (map[string]any, error) {
	if p.failure != nil {
		return nil, p.failure
	}
	if e := p.Authorize(ctx, q.Access); e != nil {
		return nil, e
	}
	if p.onDocument != nil {
		p.onDocument()
	}
	if q.Kind == "gist" {
		return map[string]any{"description": "Alice snippet", "isPublic": true, "files": []M{{"filename": "Alice.txt", "content": "hello Alice", "size": 11}}}, nil
	}
	return map[string]any{"title": "Alice change", "body": "hello Alice", "state": "open", "merged": false, "draft": false}, nil
}
func (p *fixtureProvider) DocumentURL(q provider.DocumentRequest) string {
	return "https://forge.test/" + q.Kind + "/" + q.ID
}

func (p *fixtureProvider) Branch(ctx context.Context, a provider.Access, name string) (provider.Commit, error) {
	if p.missingBranch {
		return provider.Commit{}, provider.ErrBranchNotFound
	}
	return p.Commit(ctx, a, name)
}
