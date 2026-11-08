package server

import (
	"go.mongodb.org/mongo-driver/v2/bson"
	"strings"
	"time"
)

func (s *Server) dashboard(q *request) (any, error) {
	if e := s.ensureDashboardNames(q); e != nil {
		return nil, e
	}
	pipeline, sortField, limit, err := dashboardPipeline(q, time.Now())
	if err != nil {
		return nil, err
	}
	cur, err := s.Store.DB.Collection(collection("repo")).Aggregate(q.ctx(), pipeline)
	if err != nil {
		return nil, err
	}
	defer cur.Close(q.ctx())
	rows := []M{}
	if err = cur.All(q.ctx(), &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return M{"items": []any{}, "cursor": nil, "total": 0, "attention": 0, "filtered": 0}, nil
	}
	result := rows[0]
	items := arr(result["items"])
	var cursor any
	if len(items) > limit {
		items = items[:limit]
		last := obj(items[len(items)-1])
		encoded, err := encodeDashboardCursor(sortField, last)
		if err != nil {
			return nil, err
		}
		cursor = encoded
	}
	for _, v := range items {
		m := obj(v)
		delete(m, "_sort")
		delete(m, "_id")
	}
	totals := M{}
	if a := arr(result["totals"]); len(a) > 0 {
		totals = obj(a[0])
	}
	filtered := int64(0)
	if a := arr(result["filtered"]); len(a) > 0 {
		filtered = number(obj(a[0])["count"])
	}
	return M{"items": items, "cursor": cursor, "total": number(totals["total"]), "attention": number(totals["attention"]), "filtered": filtered}, nil
}

func dashboardPipeline(q *request, now time.Time) ([]M, string, int, error) {
	query := parseExtendedQuery(q.R.URL.RawQuery).object
	sortField, err := query["sort"].stringDefault("-anonymizeDate")
	if err != nil {
		return nil, "", 0, err
	}
	field := strings.TrimPrefix(sortField, "-")
	mapping := map[string]string{"_name": "_anonymousId", "_label": "_label", "status": "status", "anonymizeDate": "anonymizeDate", "lastView": "lastView", "pageView": "pageView", "options.expirationDate": "options.expirationDate"}
	mapped, ok := mapping[field]
	if !ok {
		return nil, "", 0, fail("invalid_sort", 400)
	}
	direction := 1
	if strings.HasPrefix(sortField, "-") {
		direction = -1
	}
	rawLimit, err := query["limit"].stringValue()
	if err != nil {
		return nil, "", 0, err
	}
	limit := dashboardLimit([]string{rawLimit})
	project := func(kind string) M {
		id := idKey(kind)
		p := M{"_id": 1, "status": 1, "statusMessage": 1, "anonymizeDate": 1, "lastView": 1, "pageView": M{"$ifNull": []any{"$pageView", 0}}, "options": 1, "conference": 1, "_type": M{"$literal": kind}, "_anonymousId": M{"$ifNull": []any{"$" + id, ""}}, id: 1}
		switch kind {
		case "repo":
			p["_source"] = "$source.repositoryName"
			p["_fallbackLabel"] = "$source.repositoryName"
			p["source"] = M{"fullName": "$source.repositoryName", "commit": "$source.commit"}
			p["coauthors"] = 1
			p["size"] = 1
			p["role"] = M{"$cond": []any{M{"$eq": []any{"$owner", q.User["_id"]}}, "owner", "coauthor"}}
		case "pr":
			label := M{"$concat": []any{M{"$ifNull": []any{"$source.repositoryFullName", ""}}, "#", M{"$toString": "$source.pullRequestId"}}}
			p["_source"] = label
			p["_fallbackLabel"] = label
			p["source"] = M{"repositoryFullName": "$source.repositoryFullName", "pullRequestId": "$source.pullRequestId"}
		case "gist":
			p["_source"] = "$source.gistId"
			p["_fallbackLabel"] = M{"$concat": []any{"Gist ", M{"$ifNull": []any{"$gistId", "$source.gistId"}}}}
			p["source"] = M{"gistId": "$source.gistId"}
			p["isPublic"] = "$gist.isPublic"
		}
		return M{"$project": p}
	}
	pipeline := []M{{"$match": membership(q, "repo")}, project("repo"), {"$unionWith": M{"coll": collection("pr"), "pipeline": []M{{"$match": membership(q, "pr")}, project("pr")}}}, {"$unionWith": M{"coll": collection("gist"), "pipeline": []M{{"$match": membership(q, "gist")}, project("gist")}}},
		{"$lookup": M{"from": "dashboardnames", "let": M{"type": "$_type", "id": "$_anonymousId"}, "pipeline": []M{{"$match": M{"owner": q.User["_id"], "$expr": M{"$and": []any{M{"$eq": []any{"$type", "$$type"}}, M{"$eq": []any{"$artifactId", "$$id"}}}}}}, {"$project": M{"name": 1}}}, "as": "_privateName"}},
		{"$set": M{"projectName": M{"$ifNull": []any{M{"$arrayElemAt": []any{"$_privateName.name", 0}}, ""}}}},
		{"$unset": "_privateName"},
		{"$set": M{"status": M{"$cond": []any{M{"$and": []any{M{"$eq": []any{"$status", "ready"}}, M{"$ne": []any{"$options.expirationMode", "never"}}, M{"$ne": []any{M{"$ifNull": []any{"$options.expirationDate", nil}}, nil}}, M{"$lte": []any{"$options.expirationDate", now}}}}, "expired", "$status"}}, "_label": M{"$cond": []any{M{"$ne": []any{"$projectName", ""}}, "$projectName", M{"$ifNull": []any{"$_fallbackLabel", "$_anonymousId"}}}}}},
		{"$set": M{"_statusKey": M{"$switch": M{"branches": []M{{"case": M{"$in": []any{"$status", []string{"ready", "error"}}}, "then": "$status"}, {"case": M{"$in": []any{"$status", []string{"expired", "expiring"}}}, "then": "expired"}, {"case": M{"$in": []any{"$status", []string{"removed", "removing"}}}, "then": "removed"}}, "default": "progress"}}}},
	}
	fallback := any("")
	if field == "pageView" {
		fallback = 0
	} else if strings.Contains(field, "Date") || field == "lastView" {
		fallback = time.Unix(0, 0)
	}
	lastActivity := M{"$ifNull": []any{"$anonymizeDate", "$lastView"}}
	stale := M{"$and": []any{
		M{"$eq": []any{"$_statusKey", "progress"}},
		M{"$ne": []any{lastActivity, nil}},
		M{"$lt": []any{lastActivity, now.Add(-2 * time.Hour)}},
	}}
	attention := M{"$or": []any{M{"$eq": []any{"$status", "error"}}, M{"$eq": []any{"$_anonymousId", ""}}, stale}}
	pipeline = append(pipeline, M{"$set": M{"_attention": attention, "_sort": M{"$ifNull": []any{"$" + mapped, fallback}}}})

	if field == "_name" || field == "_label" || field == "status" {
		pipeline = append(pipeline, M{"$set": M{"_sort": M{"$toLower": "$_sort"}}})
	}
	filter, err := dashboardFilter(query)
	if err != nil {
		return nil, "", 0, err
	}
	page := []M{{"$match": filter}}
	if query["cursor"].truthy() {
		cursor, err := query["cursor"].stringValue()
		if err != nil {
			return nil, "", 0, fail("invalid_cursor", 400)
		}
		c, err := dashboardCursor(cursor, sortField, field)
		if err != nil {
			return nil, "", 0, err
		}
		value, id := c["value"], c["id"]
		op := "$gt"
		if direction < 0 {
			op = "$lt"
		}
		page = append(page, M{"$match": M{"$or": []M{{"_sort": M{op: value}}, {"_sort": value, "_type": M{"$gt": c["type"]}}, {"_sort": value, "_type": c["type"], "_id": M{"$gt": id}}}}})
	}
	page = append(page, M{"$sort": bson.D{{Key: "_sort", Value: direction}, {Key: "_type", Value: 1}, {Key: "_id", Value: 1}}}, M{"$limit": limit + 1})
	pipeline = append(pipeline, M{"$facet": M{"totals": []M{{"$group": M{"_id": nil, "total": M{"$sum": 1}, "attention": M{"$sum": M{"$cond": []any{"$_attention", 1, 0}}}}}}, "filtered": []M{{"$match": filter}, {"$count": "count"}}, "items": page}})

	return pipeline, sortField, limit, nil
}
