package server

import (
	"crypto/sha256"
	"encoding/hex"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

var billingPackPart = regexp.MustCompile(`^cs_[^:]+:(repo_slot|author_pass|repo_extend)$`)
var billingFilterWord = regexp.MustCompile(`^[a-z_]{1,40}$`)

func billingFamily(plan string) string {
	if plan == "author_monthly" || plan == "author_annual" || plan == "subscription_unknown" {
		return "subscription"
	}
	if conferencePlan(plan) {
		return "conference"
	}
	return "repository"
}
func billingStates(now time.Time) M {
	return M{"active": M{"revoked": M{"$ne": true}, "until": M{"$gt": now}, "status": M{"$in": []string{"active", "paid", "past_due"}}}, "revoked": M{"revoked": true}, "expired": M{"revoked": M{"$ne": true}, "$or": []M{{"until": M{"$not": M{"$gt": now}}}, {"status": M{"$nin": []string{"active", "paid", "past_due"}}}}}}
}
func (s *Server) billingGrantReport(q *request) (any, error) {
	q.W.Header().Set("Cache-Control", "no-store")
	query := q.R.URL.Query()
	now := time.Now()
	states := billingStates(now)
	filter := M{}
	plan, status := query.Get("plan"), query.Get("status")
	if billingFilterWord.MatchString(plan) {
		if plan == "repo_pack" {
			filter["_id"] = M{"$regex": billingPackPart.String()}
		} else {
			filter["planId"] = plan
		}
	}
	if billingFilterWord.MatchString(status) {
		filter["status"] = status
	}
	pipeline := []M{{"$match": filter}}
	if search := strings.TrimSpace(query.Get("search")); search != "" {
		pipeline = append(pipeline, M{"$set": M{"userId": M{"$convert": M{"input": "$owner", "to": "objectId", "onError": nil, "onNull": nil}}}}, M{"$lookup": M{"from": "users", "localField": "userId", "foreignField": "_id", "pipeline": []M{{"$match": M{"username": M{"$regex": regexp.QuoteMeta(search), "$options": "i"}}}, {"$project": M{"_id": 1}}}, "as": "user"}}, M{"$match": M{"user.0": M{"$exists": true}}})
	}
	page := max(int64(1), int64(math.Min(90071992547409, adminParseInt(query.Get("page"), 1))))
	limit := int64(math.Min(100, adminParseInt(query.Get("limit"), 25)))
	if limit == 0 {
		limit = 25
	}
	limit = max(int64(1), min(limit, int64(100)))
	page = min(page, int64(90071992547409))
	field := query.Get("sort")
	if field != "until" {
		field = "purchasedAt"
	}
	direction := -1
	if query.Get("direction") == "asc" {
		direction = 1
	}
	selected := []M{}
	if state, ok := states[query.Get("state")]; ok {
		selected = append(selected, M{"$match": state})
	}
	count := append(append([]M{}, selected...), M{"$count": "count"})
	listed := append(append([]M{}, selected...), M{"$sort": bson.D{{Key: field, Value: direction}, {Key: "_id", Value: -1}}}, M{"$skip": (page - 1) * limit}, M{"$limit": limit}, M{"$project": M{"owner": 1, "scope": 1, "planId": 1, "status": 1, "until": 1, "cancelAtPeriodEnd": 1, "purchasedAt": 1, "revoked": 1, "revocationReason": 1, "revokedAt": 1, "subscriptionId": 1}})
	facets := M{"total": count, "grants": listed}
	for key, state := range states {
		facets[key] = []M{{"$match": state}, {"$count": "count"}}
	}
	pipeline = append(pipeline, M{"$facet": facets})
	cursor, err := s.Store.DB.Collection("billinggrants").Aggregate(q.ctx(), pipeline)
	if err != nil {
		return nil, err
	}
	defer cursor.Close(q.ctx())
	result := M{}
	if cursor.Next(q.ctx()) {
		if err = cursor.Decode(&result); err != nil {
			return nil, err
		}
	}
	if err = cursor.Err(); err != nil {
		return nil, err
	}
	counts := func(key string) int64 {
		rows := arr(result[key])
		if len(rows) == 0 {
			return 0
		}
		return number(obj(rows[0])["count"])
	}
	ownerIDs := []bson.ObjectID{}
	for _, value := range arr(result["grants"]) {
		if id, e := oid(str(obj(value)["owner"])); e == nil {
			ownerIDs = append(ownerIDs, id)
		}
	}
	users, err := s.Store.list(q.ctx(), "users", M{"_id": M{"$in": ownerIDs}}, 0, nil)
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, user := range users {
		names[str(user["_id"])] = str(user["username"])
	}
	rows := []M{}
	for _, value := range arr(result["grants"]) {
		grant := obj(value)
		id := str(grant["_id"])
		digest := sha256.Sum256([]byte(id))
		state := "expired"
		if boolean(grant["revoked"]) {
			state = "revoked"
		} else if usableBillingGrant(grant, now) {
			state = "active"
		}
		never := !date(grant["until"]).Before(billingNeverUntil)
		until := grant["until"]
		if never {
			until = nil
		}
		scope := M{"kind": "account", "id": nil}
		parts := strings.SplitN(str(grant["scope"]), ":", 2)
		if len(parts) == 2 && (parts[0] == "repo" || parts[0] == "conference") {
			scope = M{"kind": parts[0], "id": parts[1]}
		}
		var user any
		if name := names[str(grant["owner"])]; name != "" {
			user = name
		}
		plan := str(grant["planId"])
		if plan == "" {
			plan = "unknown"
		}
		rows = append(rows, M{"id": hex.EncodeToString(digest[:])[:12], "user": user, "planId": plan, "pack": billingPackPart.MatchString(id), "family": billingFamily(plan), "subscription": str(grant["subscriptionId"]) != "", "status": grant["status"], "state": state, "purchasedAt": grant["purchasedAt"], "until": until, "never": never, "cancelAtPeriodEnd": boolean(grant["cancelAtPeriodEnd"]), "revoked": boolean(grant["revoked"]), "revocationReason": grant["revocationReason"], "revokedAt": grant["revokedAt"], "scope": scope})
	}
	statuses := []string{}
	distinct := s.Store.DB.Collection("billinggrants").Distinct(q.ctx(), "status", M{})
	var values []any
	if err = distinct.Decode(&values); err != nil {
		return nil, err
	}
	for _, v := range values {
		if str(v) != "" {
			statuses = append(statuses, str(v))
		}
	}
	sort.Strings(statuses)
	return M{"page": page, "limit": limit, "total": counts("total"), "results": rows, "stateCounts": M{"active": counts("active"), "expired": counts("expired"), "revoked": counts("revoked")}, "statuses": statuses}, nil
}
func (s *Server) billingWebhookHealth(q *request) (M, error) {
	out := M{}
	for _, spec := range []struct {
		key, collection string
		filter          M
	}{{"pending", "billingevents", M{"state": M{"$in": []string{"pending", "processing"}}}}, {"failed", "billingevents", M{"state": "failed"}}, {"unresolved", "billingaccounts", M{"checkout.key": M{"$exists": true}, "checkout.id": M{"$exists": false}}}, {"reconciliationFailed", "billingaccounts", M{"reconcileError": M{"$exists": true}}}, {"unreviewedRevocations", "billingrevocations", M{"reviewed": false}}} {
		n, err := s.Store.DB.Collection(spec.collection).CountDocuments(q.ctx(), spec.filter)
		if err != nil {
			return nil, err
		}
		out[spec.key] = n
	}
	for _, spec := range []struct {
		key, collection, sort string
		direction             int
		filter                M
		fields                []string
	}{{"oldest", "billingevents", "receivedAt", 1, M{"state": M{"$in": []string{"pending", "processing"}}}, []string{"receivedAt"}}, {"lastError", "billingevents", "nextAttemptAt", -1, M{"state": M{"$in": []string{"pending", "processing", "failed"}}, "lastError": M{"$exists": true}}, []string{"type", "state", "lastError", "attempts", "receivedAt"}}, {"latestRevocation", "billingrevocations", "createdAt", -1, M{"reviewed": false}, []string{"reason", "createdAt"}}} {
		cursor, err := s.Store.DB.Collection(spec.collection).Find(q.ctx(), spec.filter, options.Find().SetSort(bson.D{{Key: spec.sort, Value: spec.direction}}).SetLimit(1))
		if err != nil {
			return nil, err
		}
		var rows []M
		err = cursor.All(q.ctx(), &rows)
		if err != nil {
			return nil, err
		}
		out[spec.key] = nil
		if len(rows) > 0 {
			out[spec.key] = selectFields(rows[0], spec.fields...)
		}
	}
	out["oldestPendingSeconds"] = int64(0)
	if row := obj(out["oldest"]); len(row) > 0 {
		out["oldestPendingSeconds"] = int64(time.Since(date(row["receivedAt"])).Seconds())
	}
	delete(out, "oldest")
	if row := obj(out["lastError"]); len(row) > 0 {
		row["error"] = row["lastError"]
		delete(row, "lastError")
	}
	return out, nil
}
