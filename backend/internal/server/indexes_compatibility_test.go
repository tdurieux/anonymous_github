package server

import (
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"os"
	"strings"
	"testing"
)

func TestExistingNodeSubmoduleIndex(t *testing.T) {
	uri := os.Getenv("GO_TEST_MONGODB_URI")
	if uri == "" {
		t.Skip("requires disposable MongoDB")
	}
	if !strings.HasPrefix(uri, "mongodb://127.0.0.1:") {
		t.Fatal("requires local disposable MongoDB")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Disconnect(t.Context())
	db := client.Database("index_compatibility_test_" + bson.NewObjectID().Hex())
	defer db.Drop(t.Context())
	_, err = db.Collection("files").Indexes().CreateOne(t.Context(), mongo.IndexModel{Keys: bson.D{{Key: "repoId", Value: 1}, {Key: "treeGeneration", Value: 1}, {Key: "submodule", Value: 1}}, Options: options.Index().SetName("file_submodule_status").SetPartialFilterExpression(M{"submodule": M{"$exists": true}})})
	if err != nil {
		t.Fatal(err)
	}
	store := &Store{DB: db}
	for i := 0; i < 2; i++ {
		if err := store.ensureIndexes(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
}
