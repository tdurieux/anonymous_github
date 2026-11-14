package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"go.mongodb.org/mongo-driver/v2/bson"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBillingSignature(t *testing.T) {
	now := time.Unix(1800000000, 0)
	body := []byte(`{"id":"evt_fixture"}`)
	sign := func(at time.Time) string {
		stamp := fmt.Sprint(at.Unix())
		mac := hmac.New(sha256.New, []byte("synthetic-secret"))
		mac.Write([]byte(stamp + "."))
		mac.Write(body)
		return "t=" + stamp + ",v1=" + hex.EncodeToString(mac.Sum(nil))
	}
	if !stripeSignature(body, sign(now), "synthetic-secret", now) {
		t.Fatal("valid signature rejected")
	}
	for _, tc := range []struct {
		body           []byte
		header, secret string
	}{{append(append([]byte{}, body...), ' '), sign(now), "synthetic-secret"}, {body, sign(now.Add(-301 * time.Second)), "synthetic-secret"}, {body, sign(now.Add(301 * time.Second)), "synthetic-secret"}, {body, sign(now), ""}, {body, sign(now), "wrong"}} {
		if stripeSignature(tc.body, tc.header, tc.secret, now) {
			t.Fatal("invalid signature accepted")
		}
	}
	if !stripeSignature(body, sign(now)+",v1=bad", "synthetic-secret", now) {
		t.Fatal("rotation signature rejected")
	}
}
func TestStripePersistedParameters(t *testing.T) {
	params := M{"line_items": []M{{"price": "price_fixture", "quantity": 1}}, "metadata": M{"owner": "synthetic"}, "payment_method_types": []string{"card"}, "automatic_tax": M{"enabled": true}}
	before := stripeValues(params).Encode()
	encoded, err := bson.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	var restored M
	if err = bson.Unmarshal(encoded, &restored); err != nil {
		t.Fatal(err)
	}
	if after := stripeValues(restored).Encode(); before != after {
		t.Fatalf("persisted retry changes parameters: %s != %s", before, after)
	}
}
func TestConferencePaymentLifecycle(t *testing.T) {
	now := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
	start, end := now.Add(time.Hour), now.Add(24*time.Hour)
	s := &Server{Config: Config{Billing: BillingConfig{Enabled: true, Plans: []BillingPlan{{ID: "conference", PriceID: "price_fixture", Storage: 100, Repositories: 10}}}}}
	body := M{"name": "Test", "conferenceID": "fixture", "startDate": start, "endDate": end, "plan": M{"planID": "conference"}}
	if _, err := s.validateConferenceChange(body, nil, now); err != nil {
		t.Fatal(err)
	}
	previous := M{"plan": M{"planID": "conference"}, "startDate": start, "endDate": end, "status": "pending_payment"}
	body["endDate"] = end.Add(time.Hour)
	if _, err := s.validateConferenceChange(body, previous, now); err == nil {
		t.Fatal("paid review window changed")
	}
	body["endDate"] = end
	body["plan"] = M{"planID": "free_conference"}
	if _, err := s.validateConferenceChange(body, nil, now); err == nil {
		t.Fatal("free conference created with billing enabled")
	}
	if _, err := s.validateConferenceChange(body, previous, now); err == nil {
		t.Fatal("existing plan changed")
	}
}
func TestReviewCapabilitiesSecurity(t *testing.T) {
	client, token := strings.Repeat("a", 32), strings.Repeat("b", 64)
	digest := sha256.Sum256([]byte(token))
	raw, _ := json.Marshal(M{"version": 1, "keys": []M{{"clientId": client, "keyId": "rotation-1", "tokenSHA256": hex.EncodeToString(digest[:]), "notBefore": "2020-01-01T00:00:00Z", "notAfter": "2099-01-01T00:00:00Z"}}})
	value := string(raw)
	registry, err := parseReviewRegistry(&value)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{review: registry}
	request := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("X-4open-artifact-client-id", client)
		r.Header.Set("X-4open-artifact-service-key-id", "rotation-1")
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.reviewCapabilities(w, r)
		return w
	}
	if w := request("/service/v1/capabilities"); w.Code != 200 || !strings.Contains(w.Body.String(), `"available":[]`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := request("/service/v1/capabilities?token=ignored"); w.Code != 404 {
		t.Fatal("query accepted", w.Code)
	}
	for _, header := range []string{"Cookie", "Origin", "Sec-Fetch-Site"} {
		r := httptest.NewRequest("GET", "/service/v1/capabilities", nil)
		r.Header.Set(header, "")
		w := httptest.NewRecorder()
		s.reviewCapabilities(w, r)
		if w.Code != 403 {
			t.Fatal(header, w.Code)
		}
	}
	for i := 1; i < 60; i++ {
		if w := request("/service/v1/capabilities"); w.Code != 200 {
			t.Fatal("early limit", i, w.Code)
		}
	}
	if w := request("/service/v1/capabilities"); w.Code != 429 {
		t.Fatal("rate limit missing", w.Code)
	}
}
func TestBillingMonthlyRevenueAndBuckets(t *testing.T) {
	total := billingTotals{}
	total.add(M{"unit_amount": 1200, "currency": "eur", "recurring": M{"interval": "year", "interval_count": 1}}, true, "author_annual")
	total.add(nil, true, "author_monthly")
	if total.count != 2 || total.missing != 1 || total.amounts()["eur"] != float64(100) {
		t.Fatal(total)
	}
	sunday := time.Date(2026, 11, 15, 16, 0, 0, 0, time.UTC)
	if got := billingBucket(sunday, "week"); got.Day() != 9 || got.Hour() != 0 {
		t.Fatal(got)
	}
}

type previewFixture struct {
	*fixtureProvider
	previews int
}

func (p *previewFixture) PreviewTree(ctx context.Context, a provider.Access, limit int) ([]provider.Entry, bool, error) {
	p.previews++
	return []provider.Entry{{Path: "refs.bib"}, {Path: "photo.png"}, {Path: ".gitmodules"}, {Path: "../secret"}}, false, nil
}
func (p *previewFixture) PreviewFile(ctx context.Context, a provider.Access, path string, limit int64) ([]byte, int64, bool, error) {
	p.previews++
	return []byte("hello Alice"), 11, false, nil
}
func TestProviderSourcePreview(t *testing.T) {
	p := &previewFixture{fixtureProvider: &fixtureProvider{name: "team/subgroup/project", commit: "opaque:revision"}}
	registry, err := provider.New(p)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{providers: registry}
	owner := bson.NewObjectID()
	q := &request{R: httptest.NewRequest("GET", "/api/providers/fixture/repository/tree?repository=team/subgroup/project&commit=opaque:revision", nil), W: httptest.NewRecorder(), User: M{"_id": owner}, Params: map[string]string{"provider": p.ID()}, Server: s}
	result, err := s.sourcePreview(q)
	if err != nil {
		t.Fatal(err)
	}
	data := obj(result)
	if len(arr(data["files"])) != 1 || len(arr(data["binaryFiles"])) != 1 {
		t.Fatal(result)
	}
	p.revoked = true
	if _, err = s.sourcePreview(q); err == nil || p.previews != 1 {
		t.Fatal("revocation bypassed", err, p.previews)
	}
	p.revoked = false
	q.R = httptest.NewRequest("GET", "/api/providers/fixture/repository/file?repository=team/subgroup/project&commit=opaque:revision&path=../private", nil)
	if _, err = s.sourcePreview(q); err == nil || p.previews != 1 {
		t.Fatal("unsafe path reached provider", err)
	}
}

func TestSubmoduleExpansionDoesNotShareCredentials(t *testing.T) {
	sha := strings.Repeat("a", 40)
	requests := 0
	s := &Server{HTTP: &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		requests++
		var result M
		switch r.URL.Path {
		case "/repos/parent/project/contents/vendor":
			if r.Header.Get("Authorization") != "Bearer parent-secret" {
				t.Fatal("parent metadata lost authorization")
			}
			result = M{"sha": sha, "submodule_git_url": "../dependency.git"}
		case "/repos/parent/dependency/git/trees/" + sha:
			if r.Header.Get("Authorization") != "" {
				t.Fatal("parent credential leaked to child")
			}
			result = M{"tree": []M{{"type": "blob", "path": "readme.md", "sha": sha, "size": 10}, {"type": "blob", "path": ".gitmodules", "sha": sha, "size": 10}, {"type": "commit", "path": "nested", "sha": sha}}}
		default:
			t.Fatal("unexpected path", r.URL.Path)
		}
		raw, _ := json.Marshal(result)
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
	})}}
	g := &githubProvider{server: s}
	entries, err := g.expandSubmodules(t.Context(), provider.Access{Ref: provider.Ref{Name: "parent/project", Commit: sha}}, "parent-secret", []provider.Entry{{Path: ".gitmodules"}, {Path: "vendor", Revision: sha, Directory: true, Submodule: "unsupported"}})
	if err != nil || len(entries) != 3 || requests != 2 {
		t.Fatal(entries, requests, err)
	}
	if entries[0].Submodule != "included" || entries[1].Origin == nil || entries[1].Origin.Repository != "parent/dependency" || entries[2].Submodule != "nested" {
		t.Fatal(entries)
	}
	for _, raw := range []string{"https://evil.test/org/repo", "https://github.com:8443/org/repo", "https://user@github.com/org/repo", "https://github.com/org/repo?secret=x", "file:///etc/passwd", "https://github.com/org/../repo"} {
		if submoduleRepository(raw, "parent/project") != "" {
			t.Fatal("unsafe submodule URL accepted", raw)
		}
	}
}
