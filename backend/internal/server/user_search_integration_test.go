package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runUserSearchIntegration(t *testing.T, base *Server) {
	t.Run("legacy user search query and credential ordering", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		db := base.Store.DB.Client().Database("user_search_" + owner.Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		user := M{"_id": owner, "username": "owner", "status": "active"}
		if _, err := db.Collection("users").InsertOne(ctx, user); err != nil {
			t.Fatal(err)
		}
		q := &request{Server: s, User: user, Identity: identity(user), R: httptest.NewRequest("GET", "/", nil)}
		if err := s.saveGrant(q, owner, "github", M{"access_token": "synthetic-search"}); err != nil {
			t.Fatal(err)
		}
		calls := 0
		actualQuery := ""
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			calls++
			if r.URL.Path != "/search/users" || r.URL.Query().Get("per_page") != "10" || r.Header.Get("Authorization") != "Bearer synthetic-search" {
				t.Fatal("incorrect search request")
			}
			actualQuery = r.URL.Query().Get("q")
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"items":[{"login":"result","id":123,"avatar_url":"https://example.test/avatar"}]}`))}, nil
		})}
		for _, row := range userSearchContracts(t) {
			q.R = httptest.NewRequest("GET", "/?"+row.Query, nil)
			before := calls
			got, err := s.githubUsers(q)
			if (err != nil) != row.Error {
				t.Fatal(row, err)
			}
			if row.UpstreamQuery != nil {
				want := []M{{"username": "result", "githubId": "123", "photo": "https://example.test/avatar"}}
				if calls != before+1 || actualQuery != *row.UpstreamQuery || !reflect.DeepEqual(got, want) {
					t.Fatal(row, actualQuery, got)
				}
			} else if calls != before {
				t.Fatal("unexpected upstream call", row)
			}
		}
	})
}
