package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/event"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func runConferenceCapacityIntegration(t *testing.T, base *Server) {
	t.Run("conference operations exceed former list and removal limits", func(t *testing.T) {
		ctx := context.Background()
		owner := bson.NewObjectID()
		db := base.Store.DB.Client().Database("conference_capacity_" + owner.Hex())
		defer db.Drop(ctx)
		s := &Server{Config: base.Config, Store: &Store{DB: db, Redis: base.Store.Redis}, content: base.content, providers: base.providers}
		q := &request{Server: s, User: M{"_id": owner}, R: httptest.NewRequest("GET", "/api/conferences", nil), W: httptest.NewRecorder(), Params: map[string]string{}}
		q.Identity.ID = owner.Hex()
		conferences := make([]any, 0, 10001)
		for i := 0; i < 10001; i++ {
			c := M{"conferenceID": fmt.Sprintf("capacity-%05d", i), "owners": []any{owner}, "status": "removed", "repositories": []any{}, "endDate": time.Now().Add(-time.Hour)}
			if i == 10000 {
				c["status"] = "ready"
			}
			conferences = append(conferences, c)
		}
		if _, err := db.Collection("conferences").InsertMany(ctx, conferences); err != nil {
			t.Fatal(err)
		}
		var finds atomic.Int64
		monitor := &event.CommandMonitor{Started: func(_ context.Context, e *event.CommandStartedEvent) {
			if e.CommandName == "find" {
				finds.Add(1)
			}
		}}
		observed, err := mongo.Connect(options.Client().ApplyURI(os.Getenv("GO_TEST_MONGODB_URI")).SetBSONOptions(&options.BSONOptions{DefaultDocumentM: true}).SetMonitor(monitor))
		if err != nil {
			t.Fatal(err)
		}
		defer observed.Disconnect(ctx)
		s.Store.DB = observed.Database(db.Name())
		result, err := s.conferences(q)
		s.Store.DB = db
		if finds.Load() != 22 {
			t.Fatal("conference listing performed per-record reads", finds.Load())
		}
		if err != nil {
			t.Fatal(err)
		}
		listed := result.([]M)
		if len(listed) != 10001 {
			t.Fatal("conference list truncated", len(listed))
		}
		seen := map[string]bool{}
		for _, row := range listed {
			id := str(row["conferenceID"])
			if seen[id] {
				t.Fatal("duplicate conference", id)
			}
			seen[id] = true
		}
		tail, err := s.Store.one(ctx, "conferences", M{"conferenceID": "capacity-10000"})
		if err != nil || tail["status"] != "expired" {
			t.Fatal("tail conference expiry skipped", err)
		}
		// A transition crossing discovery batches must still update both histories
		// at the saved event time. Unrelated pending work must not be replayed.
		member := bson.NewObjectID()
		at := time.Now().Add(-30 * time.Minute).Truncate(time.Millisecond)
		from, to := "capacity-00000", "capacity-00500"
		if _, err := s.Store.update(ctx, "conferences", M{"conferenceID": from}, M{"$set": M{"repositories": []M{{"id": member, "addDate": at.Add(-time.Hour)}}}}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Collection(collection("repo")).InsertMany(ctx, []any{
			M{"_id": member, "conference": to, "conferenceMembership": M{"id": bson.NewObjectID(), "from": from, "to": to, "at": at}},
			M{"conferenceMembership": M{"id": bson.NewObjectID(), "from": "unrelated-from", "to": "unrelated-to", "at": "invalid"}},
		}); err != nil {
			t.Fatal(err)
		}
		result, err = s.conferences(q)
		if err != nil {
			t.Fatal(err)
		}
		counts := map[string]int64{}
		for _, row := range result.([]M) {
			counts[str(row["conferenceID"])] = number(row["nbRepositories"])
		}
		if counts[from] != 0 || counts[to] != 1 {
			t.Fatal("listing returned stale membership counts", counts[from], counts[to])
		}
		oldConference, err := s.Store.one(ctx, "conferences", M{"conferenceID": from})
		if err != nil {
			t.Fatal(err)
		}
		newConference, err := s.Store.one(ctx, "conferences", M{"conferenceID": to})
		if err != nil {
			t.Fatal(err)
		}
		if !date(obj(arr(oldConference["repositories"])[0])["removeDate"]).Equal(at) || !date(obj(arr(newConference["repositories"])[0])["addDate"]).Equal(at) {
			t.Fatal("reconciliation changed billing timestamps")
		}
		savedMember, err := s.Store.one(ctx, collection("repo"), M{"_id": member})
		if err != nil || savedMember["conferenceMembership"] != nil {
			t.Fatal("transition not completed", err)
		}
		pending, err := db.Collection(collection("repo")).CountDocuments(ctx, M{"conferenceMembership.id": M{"$exists": true}})
		if err != nil || pending != 1 {
			t.Fatal("unrelated pending work changed", pending, err)
		}
		if _, err := db.Collection(collection("repo")).DeleteMany(ctx, M{}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Collection("conferences").DeleteMany(ctx, M{}); err != nil {
			t.Fatal(err)
		}

		const count = 100001
		records := make([]any, 0, count)
		history := make([]any, 0, count)
		prefix := "capacity-" + owner.Hex()
		lastID := ""
		for i := 0; i < count; i++ {
			id := bson.NewObjectID()
			repoID := fmt.Sprintf("%s-%06d", prefix, i)
			status := "archived"
			if i == count-1 {
				status = "ready"
				lastID = repoID
			}
			records = append(records, M{"_id": id, "repoId": repoID, "owner": owner, "status": status, "statusDate": time.Now(), "source": M{"provider": "fixture"}})
			history = append(history, M{"id": id, "addDate": time.Now().Add(-time.Hour)})
		}
		if _, err := db.Collection(collection("repo")).InsertMany(ctx, records); err != nil {
			t.Fatal(err)
		}
		c := M{"_id": bson.NewObjectID(), "conferenceID": prefix, "owners": []any{owner}, "status": "ready", "repositories": history, "endDate": time.Now().Add(time.Hour)}
		if _, err := db.Collection("conferences").InsertOne(ctx, c); err != nil {
			t.Fatal(err)
		}
		// Direct lifecycle invocation below needs no membership replay; detail does.
		q.Params["id"] = prefix
		result, err = s.conferences(q)
		if err != nil {
			t.Fatal(err)
		}
		repositories := arr(obj(result)["repositories"])
		if len(repositories) != count {
			t.Fatal("conference membership view truncated", len(repositories))
		}
		seen = map[string]bool{}
		for _, value := range repositories {
			id := str(obj(value)["repoId"])
			if seen[id] {
				t.Fatal("duplicate member", id)
			}
			seen[id] = true
		}
		if !seen[lastID] {
			t.Fatal("tail conference member omitted")
		}
		if err := s.content.Put(ctx, lastID, "raw", strings.NewReader("private fixture"), 15, 15); err != nil {
			t.Fatal(err)
		}
		defer s.content.Remove(ctx, lastID, "")
		err = s.removeConference(ctx, c)
		if err == nil || err.Error() != "conference_repository_removal_failed" {
			t.Fatal("archived members did not report partial failure", err)
		}
		last, err := s.Store.one(ctx, collection("repo"), M{"repoId": lastID})
		if err != nil || last["status"] != "removed" {
			t.Fatal("removal skipped tail member", err)
		}
		entries, err := s.content.List(ctx, lastID)
		if err != nil && !errors.Is(err, fs.ErrNotExist) || len(entries) != 0 {
			t.Fatal("tail member content survived removal", len(entries), err)
		}
		archived, err := db.Collection(collection("repo")).CountDocuments(ctx, M{"status": "archived"})
		if err != nil || archived != count-1 {
			t.Fatal("archived members changed", archived, err)
		}
		saved, err := s.Store.one(ctx, "conferences", M{"_id": c["_id"]})
		if err != nil || saved["status"] != "removed" {
			t.Fatal("conference removal not durable", err)
		}
	})
}
