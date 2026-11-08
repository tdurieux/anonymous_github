package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"reflect"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runResourceOptionsDifferentialIntegration(t *testing.T, s *Server, p *fixtureProvider, token, otherToken string) {
	t.Run("resource option create edit database differential", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		name := "resource_options_" + bson.NewObjectID().Hex()
		defer s.Store.DB.Client().Database(name).Drop(context.Background())
		command := exec.CommandContext(ctx, "node", "backend/contracts/resource-options-database.cjs")
		command.Dir = "../../.."
		command.Env = append(os.Environ(), "RESOURCE_OPTIONS_DATABASE="+name, "TZ=UTC")
		raw, err := command.Output()
		if err != nil {
			if e, ok := err.(*exec.ExitError); ok {
				t.Fatalf("TypeScript option oracle: %s", e.Stderr)
			}
			t.Fatal(err)
		}
		var cases []struct {
			Kind         string
			Create       bool
			Body, Stored M
			Error        *struct {
				Status int
				Error  string
			}
		}
		if err = json.Unmarshal(raw, &cases); err != nil {
			t.Fatal(err)
		}
		if len(cases) != 150 {
			t.Fatal("unexpected option case count", len(cases))
		}
		// Compatibility covers valid inputs. Invalid casts intentionally reject
		// both creates and edits instead of reproducing TS partial writes/500s.
		inputKey := func(kind string, body M) string { raw, _ := json.Marshal(body["options"]); return kind + string(raw) }
		invalid := map[string]bool{}
		for _, c := range cases {
			if c.Create && c.Error != nil {
				invalid[inputKey(c.Kind, c.Body)] = true
			}
		}
		calls := 0
		call := func(path, credential string, body M) *httptest.ResponseRecorder {
			data, _ := json.Marshal(body)
			req := httptest.NewRequest("POST", path, bytes.NewReader(data))
			req.RemoteAddr = fmt.Sprintf("198.51.103.%d:1234", calls/30+1)
			calls++
			req.Header.Set("Authorization", "Bearer "+credential)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			s.ServeHTTP(w, req)
			return w
		}
		for i, c := range cases {
			rejected := invalid[inputKey(c.Kind, c.Body)]
			id := fmt.Sprintf("option-write-%d", i)
			body := c.Body
			body[idKey(c.Kind)] = id
			body["fullName"] = p.name
			body["source"] = M{"provider": "fixture", "branch": "main", "commit": p.commit, "gistId": "snippet", "repositoryFullName": p.name, "pullRequestId": 1}
			route := "/api/" + c.Kind
			var before M
			if !c.Create {
				seed := M{}
				for k, v := range body {
					seed[k] = v
				}
				seed["terms"] = []any{"before"}
				seed["options"] = M{"image": true, "link": true, "expirationDate": "2040-01-01T00:00:00.000Z"}
				if w := call(route, token, seed); w.Code != 200 {
					t.Fatal("seed", c.Kind, w.Code, w.Body)
				}
				route += "/" + id
				before, err = s.Store.one(ctx, collection(c.Kind), M{idKey(c.Kind): id})
				if err != nil {
					t.Fatal(err)
				}
				if w := call(route, otherToken, body); w.Code != 403 {
					t.Fatal("non-owner mutation allowed", c.Kind, w.Code, w.Body)
				}
				afterDenied, readErr := s.Store.one(ctx, collection(c.Kind), M{idKey(c.Kind): id})
				if readErr != nil || !reflect.DeepEqual(afterDenied, before) {
					t.Fatal("denied edit changed document", c.Kind, readErr)
				}
			}
			w := call(route, token, body)
			if rejected {
				var result M
				json.Unmarshal(w.Body.Bytes(), &result)
				code := "invalid_options"
				if _, present := obj(c.Body["options"])["expirationDate"]; present {
					code = "invalid_expiration_date"
				}
				if w.Code != 400 || result["error"] != code {
					t.Fatal(c.Kind, c.Create, c.Body["options"], w.Code, w.Body)
				}
			} else if w.Code != 200 {
				t.Fatal(c.Kind, c.Create, c.Body["options"], w.Code, w.Body)
			}
			stored, err := s.Store.one(ctx, collection(c.Kind), M{idKey(c.Kind): id})
			if err != nil {
				t.Fatal(err)
			}
			if rejected {
				if !reflect.DeepEqual(stored, before) {
					t.Fatal("invalid options changed document", c.Kind, c.Create)
				}
				continue
			}
			// Go consistently omits empty pageSource objects on both paths.
			if page, present := c.Stored["pageSource"]; present && page != nil && len(obj(page)) == 0 {
				delete(c.Stored, "pageSource")
			}
			if stored == nil {
				if c.Stored != nil {
					t.Fatal("missing persisted options")
				}
				continue
			}
			actual := defaultsJSON(t, responseJSON(stored["options"]))
			if !reflect.DeepEqual(actual, defaultsJSON(t, c.Stored)) {
				t.Fatalf("%s create=%v input=%v: stored %v want %v", c.Kind, c.Create, c.Body["options"], actual, c.Stored)
			}
		}
	})
}
