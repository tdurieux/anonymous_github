package server

import (
	"context"
	"errors"
	"fmt"
	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"strings"
	"time"
)

type M = bson.M
type Store struct {
	DB    *mongo.Database
	Redis *redis.Client
}

func Connect(ctx context.Context, c Config) (*Store, error) {
	// Prefer bounded-memory wire compression. The driver's zstd encoder pool
	// retains large windows per CPU, even for small per-file queries during ZIPs.
	// An explicit compressors URI option can still override this default.
	client, err := mongo.Connect(options.Client().SetCompressors([]string{"snappy"}).ApplyURI(c.MongoURI).SetBSONOptions(&options.BSONOptions{DefaultDocumentM: true}).SetAppName("Anonymous GitHub Go").SetMaxPoolSize(30).SetServerSelectionTimeout(10 * time.Second))
	if err != nil {
		return nil, errors.New("database_connection_failed")
	}
	if err = client.Ping(ctx, nil); err != nil {
		client.Disconnect(ctx)
		return nil, errors.New("database_connection_failed")
	}
	redisClient := redis.NewClient(&redis.Options{Addr: c.RedisAddress, DialTimeout: 3 * time.Second, ReadTimeout: 3 * time.Second, WriteTimeout: 3 * time.Second})
	if err = redisClient.Ping(ctx).Err(); err != nil {
		client.Disconnect(ctx)
		redisClient.Close()
		return nil, errors.New("redis_connection_failed")
	}
	s := &Store{client.Database(c.Database), redisClient}
	_, err = s.DB.Collection("credentials").Indexes().CreateOne(ctx, mongo.IndexModel{Keys: bson.D{{Key: "ownerId", Value: 1}, {Key: "provider", Value: 1}}, Options: options.Index().SetUnique(true)})
	if err != nil {
		s.Close(ctx)
		return nil, errors.New("credential_index_failed")
	}
	if err = s.ensureIndexes(ctx); err != nil {
		s.Close(ctx)
		return nil, errors.New("database_index_failed")
	}
	return s, nil
}
func (s *Store) Close(ctx context.Context) { s.Redis.Close(); s.DB.Client().Disconnect(ctx) }
func (s *Store) one(ctx context.Context, collection string, query M) (M, error) {
	var result M
	opts := options.FindOne()
	if collection == "anonymizedrepositories" {
		opts.SetCollation(&options.Collation{Locale: "en", Strength: 2})
	}
	err := s.DB.Collection(collection).FindOne(ctx, query, opts).Decode(&result)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	return result, err
}
func (s *Store) list(ctx context.Context, collection string, query M, limit int64, sort bson.D) ([]M, error) {
	opts := options.Find().SetLimit(limit)
	if len(sort) > 0 {
		opts.SetSort(sort)
	}
	cur, err := s.DB.Collection(collection).Find(ctx, query, opts)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	result := []M{}
	err = cur.All(ctx, &result)
	return result, err
}
func (s *Store) update(ctx context.Context, collection string, query, update M) (bool, error) {
	r, e := s.DB.Collection(collection).UpdateOne(ctx, query, update)
	if e != nil {
		return false, e
	}
	return r.MatchedCount > 0, nil
}
func str(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bson.ObjectID:
		return x.Hex()
	case float64:
		// JSON-decoded upstream IDs must use JavaScript's decimal/exponent
		// thresholds, not fmt's scientific notation for ordinary large IDs.
		if value, ok := termString(x); ok {
			return value
		}
		return fmt.Sprint(x)
	case nil:
		return ""
	default:
		return fmt.Sprint(x)
	}
}
func obj(v any) M {
	switch x := v.(type) {
	case bson.D:
		m := M{}
		for _, e := range x {
			m[e.Key] = e.Value
		}
		return m
	case M:
		return x
	case map[string]any:
		return M(x)
	}
	return M{}
}
func arr(v any) []any {
	switch x := v.(type) {
	case []M:
		a := make([]any, len(x))
		for i, v := range x {
			a[i] = v
		}
		return a
	case bson.A:
		return []any(x)
	case []any:
		return x
	case []string:
		a := make([]any, len(x))
		for i, s := range x {
			a[i] = s
		}
		return a
	}
	return []any{}
}
func stringsOf(v any) []string {
	a := arr(v)
	r := make([]string, 0, len(a))
	for _, x := range a {
		if s, ok := x.(string); ok {
			r = append(r, s)
		}
	}
	return r
}
func boolean(v any) bool { b, _ := v.(bool); return b }
func number(v any) int64 {
	switch x := v.(type) {
	case int:
		return int64(x)
	case int32:
		return int64(x)
	case int64:
		return x
	case float64:
		return int64(x)
	}
	return 0
}
func date(v any) time.Time {
	t, _ := storedDate(v)
	return t
}

// storedDate distinguishes a valid year-0001 timestamp from missing or invalid
// data. It parses persisted date forms, not JavaScript input coercions.
func storedDate(v any) (time.Time, bool) {
	switch x := v.(type) {
	case time.Time:
		return x, true
	case bson.DateTime:
		return x.Time(), true
	case string:
		t, err := time.Parse(time.RFC3339Nano, x)
		if err != nil {
			t, err = time.Parse("2006-01-02", x)
		}
		return t, err == nil
	}
	return time.Time{}, false
}

func latestStoredDate(values ...any) any {
	var latest time.Time
	found := false
	for _, value := range values {
		if d, valid := storedDate(value); valid && (!found || d.After(latest)) {
			latest, found = d, true
		}
	}
	if !found {
		return nil
	}
	return latest
}
func oid(s string) (bson.ObjectID, error) { return bson.ObjectIDFromHex(s) }
func collection(kind string) string {
	switch kind {
	case "repo":
		return "anonymizedrepositories"
	case "gist":
		return "anonymizedgists"
	case "pr":
		return "anonymizedpullrequests"
	}
	return ""
}
func idKey(kind string) string {
	switch kind {
	case "repo":
		return "repoId"
	case "gist":
		return "gistId"
	case "pr":
		return "pullRequestId"
	}
	return ""
}
func missing(kind string) string {
	if kind == "pr" {
		return "pull_request_not_found"
	}
	return kind + "_not_found"
}
func resourceFilter(kind, id string) M { return M{idKey(kind): id} }
func activeGeneration(r M) any {
	if s := str(r["treeGeneration"]); s != "" {
		return s
	}
	return M{"$exists": false}
}
func revisionFilter(r M) M {
	q := M{"_id": r["_id"], "status": r["status"]}
	for _, k := range []string{"statusDate", "treeGeneration", "settingsSavedAt"} {
		if v, ok := r[k]; ok {
			q[k] = v
		} else {
			q[k] = M{"$exists": false}
		}
	}
	field := "githubAccess"
	if id, _ := sourceProvider(obj(r["source"])); id != "github" {
		field = "providerAccess"
	}
	a := obj(r[field])
	if v, ok := a["revision"]; ok {
		q[field+".revision"] = v
	} else {
		q[field+".revision"] = M{"$exists": false}
	}
	return q
}
func selectFields(m M, keys ...string) M {
	out := M{}
	for _, k := range keys {
		if v, ok := m[k]; ok {
			out[k] = v
		}
	}
	return out
}
func resourceJSON(kind string, m M) M {
	out := selectFields(m, idKey(kind), "options", "conference", "anonymizeDate", "status", "statusMessage", "lastView", "pageView")
	source := obj(m["source"])
	switch kind {
	case "repo":
		if str(m["status"]) != "ready" {
			out["size"] = M{"storage": 0, "file": 0}
		} else if v, ok := m["size"]; ok {
			out["size"] = v
		}
		authors := []M{}
		for _, v := range arr(m["coauthors"]) {
			authors = append(authors, selectFields(obj(v), "username", "githubId", "photo"))
		}
		out["coauthors"] = authors
		out["source"] = selectFields(source, "type", "branch", "commit")
		if v, ok := source["repositoryId"]; ok {
			obj(out["source"])["repositoryID"] = v
		}
		if v, ok := source["repositoryName"]; ok {
			obj(out["source"])["fullName"] = v
		}
		if id := str(source["provider"]); id != "" {
			obj(out["source"])["provider"] = id
		}
	case "gist":
		out["source"] = selectFields(source, "gistId")
		if m["gist"] != nil {
			g := obj(m["gist"])
			payload := selectFields(g, "description", "isPublic", "creationDate", "updatedDate", "ownerLogin")
			files := []M{}
			for _, v := range arr(g["files"]) {
				files = append(files, selectFields(obj(v), "filename", "content", "language", "size", "type"))
			}
			comments := []M{}
			for _, v := range arr(g["comments"]) {
				comments = append(comments, selectFields(obj(v), "body", "creationDate", "updatedDate", "author"))
			}
			payload["files"] = files
			payload["comments"] = comments
			out["gist"] = payload
		}
		if value, ok := obj(m["gist"])["isPublic"]; ok {
			out["isPublic"] = value
		}
	case "pr":
		out["source"] = selectFields(source, "pullRequestId", "repositoryFullName")
		if v, ok := m["pullRequest"]; ok {
			out["pullRequest"] = v
		}
		for _, k := range []string{"state", "merged", "mergedDate"} {
			if v, ok := obj(m["pullRequest"])[k]; ok {
				out[k] = v
			}
		}
	}
	if id := str(source["provider"]); id != "" {
		obj(out["source"])["provider"] = id
	}
	return out
}
func safeRepositoryName(name string) bool {
	parts := strings.Split(name, "/")
	if len(parts) != 2 {
		return false
	}
	for _, s := range parts {
		if s == "" || s == "." || s == ".." {
			return false
		}
		for _, r := range s {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_.-", r)) {
				return false
			}
		}
	}
	return true
}

func decimal(v any) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return float64(number(v))
}
