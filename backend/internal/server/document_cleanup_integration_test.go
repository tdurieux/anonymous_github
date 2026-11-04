package server

import (
	"context"
	"fmt"
	"go.mongodb.org/mongo-driver/v2/bson"
	"reflect"
	"testing"
)

func runDocumentCleanupIntegration(t *testing.T, s *Server) {
	t.Run("document removal and expiry preserve metadata", func(t *testing.T) {
		ctx := context.Background()
		for i, c := range documentCleanupCases(t) {
			for _, action := range []string{"remove", "expire"} {
				state, target := "removing", "removed"
				if action == "expire" {
					state, target = "expiring", "expired"
				}
				id := fmt.Sprintf("document-cleanup-%s-%d-%s", c.Kind, i, action)
				field := "gist"
				if c.Kind == "pr" {
					field = "pullRequest"
				}
				row := M{"_id": bson.NewObjectID(), idKey(c.Kind): id, "owner": bson.NewObjectID(), "status": state, "source": M{"provider": "fixture"}, field: c.Input}
				if _, err := s.Store.DB.Collection(collection(c.Kind)).InsertOne(ctx, row); err != nil {
					t.Fatal(err)
				}
				if err := s.runJob(ctx, M{"kind": c.Kind, "resourceId": id, "action": action}); err != nil {
					t.Fatal(err)
				}
				saved, err := s.Store.one(ctx, collection(c.Kind), M{"_id": row["_id"]})
				if err != nil {
					t.Fatal(err)
				}
				if saved["status"] != target || !reflect.DeepEqual(defaultsJSON(t, saved[field]), defaultsJSON(t, c.Expected)) {
					t.Fatal("persisted cleanup differs from TypeScript", id, saved[field])
				}
				if err := s.runJob(ctx, M{"kind": c.Kind, "resourceId": id, "action": action}); err != nil {
					t.Fatal("repeat cleanup", err)
				}
			}
		}
	})
}
