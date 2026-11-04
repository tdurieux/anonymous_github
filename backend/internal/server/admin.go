package server

import (
	"encoding/json"
	"go.mongodb.org/mongo-driver/v2/bson"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func pageInt(v string, fallback, upper int64) int64 {
	n, e := strconv.ParseInt(v, 10, 64)
	if e != nil || n < 1 {
		return fallback
	}
	return min(n, upper)
}
func (s *Server) aggregate(q *request, coll string, pipeline []M) ([]M, error) {
	cur, e := s.Store.DB.Collection(coll).Aggregate(q.ctx(), pipeline)
	if e != nil {
		return nil, e
	}
	defer cur.Close(q.ctx())
	out := []M{}
	e = cur.All(q.ctx(), &out)
	return out, e
}
func (s *Server) adminList(kind string) handler {
	return func(q *request) (any, error) {
		coll := collection("repo")
		if kind == "users" {
			coll = "users"
		}
		if kind == "conferences" {
			coll = "conferences"
		}
		page, limit, sort, csv, err := adminListPage(q.R.URL.RawQuery)
		if err != nil {
			return nil, err
		}
		v, err := adminFilterQuery(kind, q.R.URL.RawQuery)
		if err != nil {
			return nil, err
		}
		query := parseExtendedQuery(q.R.URL.RawQuery).object
		fields := M{}
		for _, key := range []string{"owner", "conference", "status"} {
			if query[key].truthy() {
				fields[key] = query[key].nativeValue()
			}
		}
		var owner M
		if kind == "repos" && query["owner"].truthy() {
			predicate, _, err := adminCastPredicate(query["owner"])
			if err != nil {
				return nil, err
			}
			owner, err = s.Store.one(q.ctx(), "users", M{"username": predicate})
			if err != nil {
				return nil, err
			}
		}
		filter, missingOwner, err := adminFilter(kind, v, owner, adminFilterOptions{fields, q.R.URL.RawQuery})
		if err != nil {
			return nil, err
		}
		if missingOwner {
			return M{"query": filter, "page": page, "total": 0, "sort": sort, "results": []M{}, "statusCounts": []M{}, "totalSize": 0}, nil
		}
		aggregateFilter := filter
		castFields := M{}
		for key, value := range fields {
			castFields[key] = value
		}
		castKey := ""
		if kind == "repos" {
			castKey = "conference"
		} else if kind == "users" {
			castKey = "status"
		}
		if castKey != "" && query[castKey].truthy() {
			cast, raw, err := adminCastPredicate(query[castKey])
			if err != nil {
				return nil, err
			}
			fields[castKey] = raw
			castFields[castKey] = cast
			filter, _, err = adminFilter(kind, v, owner, adminFilterOptions{fields, q.R.URL.RawQuery})
			if err != nil {
				return nil, err
			}
		}
		castFilter, _, err := adminFilter(kind, v, owner, adminFilterOptions{castFields, q.R.URL.RawQuery})
		if err != nil {
			return nil, err
		}
		if csv {
			return s.adminCSV(q, kind, coll, castFilter, sort)
		}
		projection := M{"accessTokens": 0, "accessTokenDates": 0, "apiTokens": 0, "source.accessToken": 0, "accessToken": 0, "refreshToken": 0, "cleanupToken": 0}
		pipeline := []M{{"$match": aggregateFilter}, {"$sort": sort}, {"$skip": (page - 1) * limit}, {"$limit": limit}, {"$project": projection}}
		if kind == "users" {
			pipeline = append(pipeline, M{"$addFields": M{"repoCount": M{"$size": M{"$ifNull": []any{"$repositories", []any{}}}}}})
		}
		var results []M
		var e error
		if kind == "users" {
			results, e = s.aggregate(q, coll, pipeline)
		} else {
			results, e = s.adminFindPage(q, coll, castFilter, sort, projection, page, limit)
		}
		if e != nil {
			return nil, e
		}
		total, e := s.Store.DB.Collection(coll).CountDocuments(q.ctx(), castFilter)
		if e != nil {
			return nil, e
		}
		group := M{"_id": "$status", "count": M{"$sum": 1}}
		if kind == "repos" {
			group["storage"] = M{"$sum": "$size.storage"}
		}
		counts, e := s.aggregate(q, coll, []M{{"$match": aggregateFilter}, {"$group": group}})
		if e != nil {
			return nil, e
		}
		out := M{"query": filter, "page": page, "total": total, "sort": sort, "results": results, "statusCounts": counts}
		if kind == "repos" {
			var size int64
			for _, row := range counts {
				size += number(row["storage"])
			}
			out["totalSize"] = size
		}
		return out, nil
	}
}
func (s *Server) adminUser(action string) handler {
	return func(q *request) (any, error) {
		u, e := s.Store.one(q.ctx(), "users", M{"username": q.Params["username"]})
		if e != nil {
			return nil, e
		}
		if u == nil {
			return nil, fail("user_not_found", 404)
		}
		if action == "get" {
			return s.adminUserDetail(q.ctx(), u)
		}
		if action == "repos" {
			rows, e := s.Store.list(q.ctx(), collection("repo"), repositoryMembership(u), 0, nil)
			if e != nil {
				return nil, e
			}
			rows, e = s.markListExpired(q.ctx(), "repo", rows)
			if e != nil {
				return nil, e
			}
			out := []M{}
			for _, r := range rows {
				out = append(out, resourceJSON("repo", r))
			}
			return out, nil
		}
		set := M{}
		switch action {
		case "ban":
			set["status"] = "banned"
		case "activate":
			set["status"] = "active"
		case "promote":
			set["isAdmin"] = true
		case "demote":
			set["isAdmin"] = false
		default:
			return nil, fail("invalid_action", 400)
		}
		matched, e := s.Store.update(q.ctx(), "users", M{"_id": u["_id"]}, M{"$set": set})
		if e != nil {
			return nil, e
		}
		if !matched {
			return nil, fail("user_not_found", 404)
		}
		out := M{"ok": true}
		if action == "ban" {
			rows, e := s.Store.list(q.ctx(), collection("repo"), M{"owner": u["_id"], "status": M{"$nin": []string{"removed", "removing"}}}, 0, nil)
			if e != nil {
				return nil, e
			}
			queued := 0
			for _, r := range rows {
				ok, e := s.Store.update(q.ctx(), collection("repo"), revisionFilter(r), M{"$set": M{"status": "removing", "statusDate": time.Now()}})
				if e != nil || !ok {
					continue
				}
				// Match the TypeScript best-effort loop. A failed enqueue keeps
				// the removing state durable for the maintenance retry.
				if e := s.enqueue(q.ctx(), "repo", str(r["repoId"]), "remove"); e != nil {
					continue
				}
				queued++
			}
			out["reposQueued"] = queued
		}
		return out, nil
	}
}
func (s *Server) adminStats(q *request) (any, error) {
	counts, e := s.aggregate(q, collection("repo"), []M{{"$group": M{"_id": "$status", "count": M{"$sum": 1}, "storage": M{"$sum": "$size.storage"}}}})
	if e != nil {
		return nil, e
	}
	var size int64
	for _, r := range counts {
		size += number(r["storage"])
	}
	users, e := s.Store.DB.Collection("users").CountDocuments(q.ctx(), M{})
	if e != nil {
		return nil, e
	}
	conferences, e := s.Store.DB.Collection("conferences").CountDocuments(q.ctx(), M{})
	if e != nil {
		return nil, e
	}
	recent, e := s.Store.DB.Collection(collection("repo")).CountDocuments(q.ctx(), M{"status": "error", "statusDate": M{"$gte": time.Now().Add(-24 * time.Hour)}})
	return M{"statusBreakdown": counts, "totalStorage": size, "recentErrors24h": recent, "totalUsers": users, "totalConferences": conferences}, e
}
func (s *Server) adminPerformance(q *request) (any, error) {
	report, err := s.requestPerformance(q)
	if err != nil {
		return nil, err
	}
	out := obj(report)
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	out["runtime"], out["requests"], out["failures"], out["uptime"] = runtime.Version(), s.requests.Load(), s.failures.Load(), time.Since(s.started).Seconds()
	out["heapBytes"], out["goroutines"] = m.HeapAlloc, runtime.NumGoroutine()
	if s.pool != nil {
		out["workers"] = s.pool.Stats()
	}
	return out, nil
}
func (s *Server) adminErrors(q *request) (any, error) {
	const key = "admin:errors"
	if s.Store == nil || s.Store.Redis == nil {
		if q.R.Method == "DELETE" {
			return M{"ok": true, "cleared": 0}, nil
		}
		return M{"available": false, "entries": []any{}, "total": 0, "offset": 0, "limit": 0, "max": errorLogMax}, nil
	}
	if err := s.flushErrorLog(q.ctx()); err != nil {
		return nil, err
	}
	if q.R.Method == "DELETE" {
		n, err := s.Store.Redis.LLen(q.ctx(), key).Result()
		if err != nil {
			return nil, err
		}
		keys := []string{}
		var cursor uint64
		for {
			batch, next, err := s.Store.Redis.Scan(q.ctx(), cursor, "admin:errors:hourly:*", 100).Result()
			if err != nil {
				return nil, err
			}
			keys = append(keys, batch...)
			if len(keys) > 10000 {
				return nil, fail("error_history_too_large", 503)
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
		pipe := s.Store.Redis.TxPipeline()
		pipe.Del(q.ctx(), key, "admin:errors:dropped")
		if len(keys) > 0 {
			pipe.Del(q.ctx(), keys...)
		}
		if _, err = pipe.Exec(q.ctx()); err != nil {
			return nil, err
		}
		return M{"ok": true, "cleared": n, "hourlyCleared": len(keys)}, nil
	}
	offset, limit, err := errorQueryPage(q.R.URL.RawQuery)
	if err != nil {
		return nil, err
	}
	raw, err := s.Store.Redis.LRange(q.ctx(), key, offset, offset+limit-1).Result()
	if err != nil {
		return nil, err
	}
	entries := []any{}
	for _, v := range raw {
		var value any
		if json.Unmarshal([]byte(v), &value) != nil {
			value = M{"ts": nil, "module": nil, "message": v, "raw": []any{}}
		}
		entries = append(entries, value)
	}
	n, err := s.Store.Redis.LLen(q.ctx(), key).Result()
	return M{"available": true, "entries": entries, "total": n, "offset": offset, "limit": limit, "max": errorLogMax}, err
}
func queueAction(name string) string {
	switch name {
	case "download":
		return "prepare"
	case "remove":
		return "remove"
	case "cache":
		return "cache"
	}
	return ""
}

// queueActions is shared by workers and administration so every runnable job
// is visible to the controls for its queue.
func queueActions(name string) []string {
	if name == "remove" {
		return []string{"remove", "expire"}
	}
	if action := queueAction(name); action != "" {
		return []string{action}
	}
	return nil
}
func (s *Server) adminQueues(q *request) (any, error) {
	name := q.Params["name"]
	search := ""
	if q.R.Method == "GET" {
		query := parseExtendedQuery(q.R.URL.RawQuery).object
		var err error
		search, err = query["search"].stringDefault("")
		if err != nil {
			return nil, err
		}
		search = strings.ToLower(search)
		if name == "" {
			name, err = query["queue"].stringDefault("")
			if err != nil {
				return nil, err
			}
		}
	}
	if name == "" {
		name = "download"
	}
	actions := queueActions(name)
	if len(actions) == 0 && q.R.Method == "GET" {
		name, actions = "download", queueActions("download")
	}
	if len(actions) == 0 {
		return nil, fail("queue_not_found", 404)
	}
	if q.R.Method == "GET" {
		_ = s.flushRequestMetrics(q.ctx())
		instances, _ := s.readProcessInstances(q.ctx(), time.Now())
		stats := []M{}
		for _, n := range []string{"download", "remove", "cache"} {
			counts, e := s.aggregate(q, "gojobs", []M{{"$match": M{"action": M{"$in": queueActions(n)}}}, {"$group": M{"_id": "$state", "count": M{"$sum": 1}}}})
			if e != nil {
				return nil, e
			}
			c := M{"waiting": 0, "active": 0, "completed": 0, "failed": 0, "delayed": 0}
			for _, r := range counts {
				c[str(r["_id"])] = r["count"]
			}
			paused, e := s.Store.Redis.Exists(q.ctx(), "go:pause:"+n).Result()
			if e != nil {
				return nil, e
			}
			label := map[string]string{"download": "Download", "remove": "Remove", "cache": "Cache cleanup"}[n]
			var completed, failed int64
			for _, point := range s.queueMetricPoints(q.ctx(), n, 1440, time.Now()) {
				completed += point.Completed
				failed += point.Failed
			}
			workers := 0
			var concurrency any
			for _, instance := range instances {
				if instance["runtime"] != "go" || instance["service"] != "api" {
					continue
				}
				count := number(obj(instance["queueWorkers"])[n])
				if count > 0 {
					workers++
					if concurrency == nil {
						concurrency = count
					}
				}
			}
			stats = append(stats, M{"key": n, "label": label, "counts": c, "paused": paused > 0, "workers": workers, "concurrency": concurrency, "completed24h": completed, "failed24h": failed})
		}
		rows := []M{}
		for _, state := range []string{"active", "waiting", "delayed", "failed", "completed"} {
			selected, e := s.Store.list(q.ctx(), "gojobs", M{"action": M{"$in": actions}, "state": state}, 200, bson.D{{Key: "createdAt", Value: -1}})
			if e != nil {
				return nil, e
			}
			rows = append(rows, selected...)
		}
		jobs := []M{}
		for _, r := range rows {
			if search != "" && !strings.Contains(strings.ToLower(str(r["resourceId"])), search) && !strings.Contains(strings.ToLower(str(r["_id"])), search) {
				continue
			}
			job := M{"id": r["_id"], "name": r["resourceId"], "_state": r["state"], "timestamp": date(r["createdAt"]).UnixMilli(), "attemptsMade": r["attempts"], "failedReason": r["error"], "data": M{"repoId": r["resourceId"]}}
			if d, valid := storedDate(r["availableAt"]); r["state"] == "delayed" && valid {
				job["delayUntil"] = d.UnixMilli()
			}
			if d, valid := storedDate(r["startedAt"]); valid {
				job["processedOn"] = d.UnixMilli()
			}
			if d, valid := storedDate(r["finishedAt"]); valid {
				job["finishedOn"] = d.UnixMilli()
			}
			jobs = append(jobs, job)
		}
		return M{"queues": stats, "selectedQueue": name, "jobs": jobs}, nil
	}
	operation := q.Params["operation"]
	if q.R.Method == "DELETE" {
		return s.adminJob(q, operation, actions)
	}
	switch operation {
	case "pause", "resume":
		if operation == "pause" {
			if e := s.Store.Redis.Set(q.ctx(), "go:pause:"+name, "1", 0).Err(); e != nil {
				return nil, e
			}
		} else {
			if e := s.Store.Redis.Del(q.ctx(), "go:pause:"+name).Err(); e != nil {
				return nil, e
			}
		}
	case "retry-failed":
		return s.retryFailedJobs(q.ctx(), actions...)
	case "drain", "empty":
		filter := M{"action": M{"$in": actions}}
		if operation == "drain" {
			filter["state"] = M{"$in": []string{"waiting", "delayed"}}
		}
		if _, e := s.Store.DB.Collection("gojobs").DeleteMany(q.ctx(), filter); e != nil {
			return nil, e
		}
	default:
		id := q.Params["id"]
		if id == "" {
			id = operation
		}
		if id == "" {
			return nil, fail("invalid_job", 400)
		}
		return s.adminJob(q, id, actions)
	}
	return M{"ok": true}, nil
}
func (s *Server) registerAdmin() {
	s.add("GET", "/api/admin/errors/stats", "admin", s.errorStats)
	s.add("GET", "/api/admin/overview", "admin", s.overview)
	s.add("GET", "/api/admin/queues/metrics", "admin", s.queueMetrics)
	s.add("GET", "/api/admin/repos/:id/github", "admin", s.adminGitHub)
	for _, kind := range []string{"users", "repos", "conferences"} {
		s.add("GET", "/api/admin/"+kind, "admin", s.adminList(kind))
	}
	s.add("GET", "/api/admin/users/:username", "admin", s.adminUser("get"))
	s.add("GET", "/api/admin/users/:username/repos", "admin", s.adminUser("repos"))
	for _, action := range []string{"ban", "activate", "promote", "demote"} {
		s.add("POST", "/api/admin/users/:username/"+action, "admin", s.adminUser(action))
	}
	s.add("GET", "/api/admin/stats", "admin", s.adminStats)
	s.add("GET", "/api/admin/performance", "admin", s.adminPerformance)
	s.add("GET", "/api/admin/cache", "admin", s.adminCache)
	for _, method := range []string{"GET", "DELETE"} {
		s.add(method, "/api/admin/errors", "admin", s.adminErrors)
	}
	s.add("GET", "/api/admin/queues", "admin", s.adminQueues)
	for _, operation := range []string{"retry-failed", "drain", "pause", "resume", "empty"} {
		s.add("POST", "/api/admin/queue/:name/"+operation, "admin", func(q *request) (any, error) {
			q.Params["operation"] = operation
			return s.adminQueues(q)
		})
	}
	for _, method := range []string{"POST", "DELETE"} {
		s.add(method, "/api/admin/queue/:name/:operation", "admin", s.adminQueues)
	}
	s.add("POST", "/api/admin/queues/pause-all", "admin", func(q *request) (any, error) {
		for _, n := range []string{"download", "remove", "cache"} {
			if e := s.Store.Redis.Set(q.ctx(), "go:pause:"+n, "1", 0).Err(); e != nil {
				return nil, e
			}
		}
		return M{"ok": true}, nil
	})
	s.add("DELETE", "/api/admin/repos/:id", "admin", func(q *request) (any, error) {
		r, e := q.resource("repo", false)
		if e != nil {
			return nil, e
		}
		if e = s.resetContentCache(q.ctx(), r); e != nil {
			return nil, e
		}
		return M{"status": r["status"]}, nil
	})
}

func errorQueryPage(raw string) (offset, limit int64, err error) {
	query := parseExtendedQuery(raw).object
	value, err := query["offset"].stringDefault("0")
	if err != nil {
		return 0, 0, err
	}
	offset = max(0, errorPageInt(value, 0))
	value, err = query["limit"].stringDefault("250")
	if err != nil {
		return 0, 0, err
	}
	limit = min(int64(errorLogMax), max(int64(1), errorPageInt(value, 250)))
	return
}
