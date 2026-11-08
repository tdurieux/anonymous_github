package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"reflect"
	"sort"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func runAdminCastingIntegration(t *testing.T, base *Server) {
	t.Run("admin Mongoose casting database differential", func(t *testing.T) {
		name := "admin_cast_" + bson.NewObjectID().Hex()
		db := base.Store.DB.Client().Database(name)
		defer db.Drop(context.Background())
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, "node", "backend/contracts/admin-casting-database.cjs")
		command.Dir = "../../.."
		command.Env = append(os.Environ(), "ADMIN_CAST_DATABASE="+name, "TZ=UTC")
		raw, err := command.Output()
		if err != nil {
			if e, ok := err.(*exec.ExitError); ok {
				t.Fatalf("TypeScript database oracle: %s", e.Stderr)
			}
			t.Fatal(err)
		}
		var cases []struct {
			Kind, Query string
			Output      any
			CSV         *string
			Error       bool
		}
		if err = json.Unmarshal(raw, &cases); err != nil {
			t.Fatal(err, string(raw))
		}
		if len(cases) != 44 {
			t.Fatal("unexpected case count", len(cases))
		}
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}}
		for _, row := range cases {
			w := httptest.NewRecorder()
			q := &request{Server: s, W: w, R: httptest.NewRequest("GET", "/?"+row.Query, nil)}
			value, err := s.adminList(row.Kind)(q)
			if (err != nil) != row.Error {
				t.Fatal(row.Kind, row.Query, err, row.Error)
			}
			if err != nil {
				continue
			}
			if row.CSV != nil {
				if w.Body.String() != *row.CSV {
					t.Fatal(row.Kind, row.Query, "CSV", w.Body.String(), *row.CSV)
				}
				continue
			}
			out := obj(value)
			ids := []any{}
			for _, item := range arr(out["results"]) {
				ids = append(ids, obj(item)["_id"])
			}
			out["results"] = ids
			counts := arr(out["statusCounts"])
			sort.Slice(counts, func(i, j int) bool { return str(obj(counts[i])["_id"]) < str(obj(counts[j])["_id"]) })
			out["statusCounts"] = counts
			data, err := json.Marshal(responseJSON(out))
			if err != nil {
				t.Fatal(err)
			}
			var normalized any
			if err = json.Unmarshal(data, &normalized); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(normalized, row.Output) {
				expected, _ := json.Marshal(row.Output)
				t.Fatalf("%s %s\ngot %s\nwant %s", row.Kind, row.Query, data, expected)
			}
		}
	})
}
