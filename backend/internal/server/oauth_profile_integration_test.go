package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAppProfileIntegration(t *testing.T, base *Server) {
	t.Run("invalid App profiles cannot create or bind identities", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		db := base.Store.DB.Client().Database("app_profile_" + owner.Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		s.Config.AppEnabled = true
		s.Config.AppNewConnections = true
		if _, err := db.Collection("users").InsertOne(ctx, M{"_id": owner, "username": "synthetic-login", "status": "active", "externalIDs": M{"github": "42"}}); err != nil {
			t.Fatal(err)
		}
		var profile M
		s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			var data M
			switch r.URL.Path {
			case "/login/oauth/access_token":
				data = M{"access_token": "synthetic-token", "refresh_token": "synthetic-refresh", "expires_in": 3600, "refresh_token_expires_in": 7200}
			case "/user":
				data = profile
			default:
				t.Fatal("unexpected profile callback endpoint", r.URL)
			}
			body, err := json.Marshal(data)
			if err != nil {
				t.Fatal(err)
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(body)))}, nil
		})}
		for _, tc := range appProfileContracts(t) {
			if !tc.Rejected {
				continue
			}
			t.Run(tc.Name, func(t *testing.T) {
				profile = tc.Profile
				q := &request{Server: s, Session: M{}, R: httptest.NewRequest("GET", "/github/app/login", nil), W: httptest.NewRecorder()}
				defer func() { s.Store.Redis.Del(ctx, "anoGH_session:"+q.SessionID) }()
				if _, err := s.oauthStart(q); err != nil {
					t.Fatal(err)
				}
				target, err := url.Parse(q.W.(*httptest.ResponseRecorder).Header().Get("Location"))
				if err != nil {
					t.Fatal(err)
				}
				state := target.Query().Get("state")
				sid := q.SessionID
				q.R = httptest.NewRequest("GET", "/github/app/callback?state="+state+"&code=synthetic", nil)
				q.W = httptest.NewRecorder()
				_, err = s.oauthCallback(q)
				if err == nil || err.Error() != "github_app_reconnect_required" {
					t.Fatal("malformed profile accepted", err)
				}
				if q.SessionID != sid || q.Identity.Active() || q.Session["passport"] != nil {
					t.Fatal("malformed profile authenticated")
				}
				users, err := db.Collection("users").CountDocuments(ctx, M{})
				if err != nil || users != 1 {
					t.Fatal("malformed profile created user", users, err)
				}
				grants, err := db.Collection("credentials").CountDocuments(ctx, M{})
				if err != nil || grants != 0 {
					t.Fatal("malformed profile bound grant", grants, err)
				}
				if count, err := s.Store.Redis.Exists(ctx, "go:oauth:"+state).Result(); err != nil || count != 0 {
					t.Fatal("rejected callback state retained", count, err)
				}
			})
		}
	})
}
