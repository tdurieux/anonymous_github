package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAccessPaginationIntegration(t *testing.T, base *Server) {
	t.Run("App selection reaches installation repositories beyond page 1000", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		db := base.Store.DB.Client().Database("access_pagination_" + owner.Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		s.Config.AppEnabled = true
		if _, err := db.Collection("users").InsertOne(ctx, M{"_id": owner, "username": owner.Hex(), "status": "active"}); err != nil {
			t.Fatal(err)
		}
		q := &request{Server: s, R: httptest.NewRequest("GET", "/", nil)}
		if err := s.saveGrant(q, owner, "github-app-user", M{"access_token": "synthetic-app", "refresh_token": "synthetic-refresh", "expires_in": float64(3600), "refresh_token_expires_in": float64(7200)}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Collection("githubinstallations").InsertOne(ctx, M{"appId": s.Config.AppID, "installationId": int64(9), "blocked": true}); err != nil {
			t.Fatal(err)
		}
		lateFailure := false
		pages, identityChecks, fallbackCalls := 0, 0, 0
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			status := 200
			var data any
			switch r.URL.Path {
			case "/user/installations":
				data = M{"installations": []M{{"id": 9, "app_id": s.Config.AppID}}}
			case "/user/installations/9/repositories":
				pages++
				page, _ := strconv.Atoi(r.URL.Query().Get("page"))
				if page != pages {
					t.Fatal("wrong page sequence", page, pages)
				}
				rows := []M{}
				for i := 0; i < 100; i++ {
					rows = append(rows, M{"id": 1, "full_name": "other/project"})
				}
				if page == 1001 {
					rows = []M{{"id": 42, "full_name": "renamed/project"}}
					if lateFailure {
						status = 503
					}
				}
				data = M{"repositories": rows}
			case "/repositories/42":
				identityChecks++
				data = M{"id": 42}
			default:
				fallbackCalls++
				data = M{"id": 42, "full_name": "renamed/project", "private": false, "visibility": "public"}
			}
			b, err := json.Marshal(data)
			if err != nil {
				t.Fatal(err)
			}
			return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(b)))}, nil
		})}
		for _, id := range []string{"", "42"} {
			pages, identityChecks, fallbackCalls = 0, 0, 0
			name := "renamed/project"
			if id != "" {
				name = "original/project"
			}
			_, binding, resolved, err := s.selectAccessIdentity(ctx, owner, name, "github-app", id)
			if err == nil || err.Error() != "github_app_access_required" || pages != 1001 || identityChecks != 0 || fallbackCalls != 0 || number(binding["installationId"]) != 9 || resolved != "renamed/project" {
				t.Fatal("late installed identity lost or blocked installation bypassed", pages, identityChecks, fallbackCalls, binding, resolved, err)
			}
		}
		lateFailure = true
		pages, identityChecks, fallbackCalls = 0, 0, 0
		_, binding, _, err := s.selectAccessIdentity(ctx, owner, "renamed/project", "github-app", "")
		if err == nil || err.Error() != "github_unavailable" || binding != nil || pages != 1001 || identityChecks != 0 || fallbackCalls != 0 {
			t.Fatal("late failure fell through to public access", pages, identityChecks, fallbackCalls, binding, err)
		}
	})
}
