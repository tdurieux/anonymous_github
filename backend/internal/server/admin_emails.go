package server

import (
	"context"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"regexp"
	"strings"
	"time"
)

type emailPeriod struct {
	name  string
	days  int
	start time.Time
}

var emailCursorID = regexp.MustCompile(`^[0-9a-f-]{36}$`)

func emailHistoryFilters(raw string, summary bool, now time.Time) (M, emailPeriod, error) {
	values := parseExtendedQuery(raw).object
	period := emailPeriod{name: "all", days: 30}
	bad := func() (M, emailPeriod, error) { return nil, period, fail("Invalid email history filters.", 400) }
	if v := values["period"]; v != nil {
		if v.kind != 's' {
			return bad()
		}
		period.name = v.scalar
		switch v.scalar {
		case "all":
		case "7d":
			period.days = 7
		case "30d":
		case "90d":
			period.days = 90
		default:
			return bad()
		}
	}
	today := now.UTC()
	period.start = time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1-period.days)
	filter := M{}
	if period.name != "all" {
		filter["createdAt"] = M{"$gte": period.start}
	}
	for key, allowed := range map[string][]string{"state": {"sending", "accepted", "rejected", "unknown"}, "kind": {"repository-expiration", "owner-access"}} {
		if summary && key == "state" {
			continue
		}
		v := values[key]
		if v == nil || !v.truthy() {
			continue
		}
		if v.kind != 's' {
			return bad()
		}
		valid := false
		for _, option := range allowed {
			if v.scalar == option {
				valid = true
			}
		}
		if !valid {
			return bad()
		}
		filter[key] = v.scalar
	}
	if v := values["search"]; v != nil {
		if v.kind != 's' || utf16Length(v.scalar) > 200 {
			return bad()
		}
		if search := strings.TrimSpace(v.scalar); search != "" {
			filter["$or"] = []M{{"recipient": M{"$regex": regexp.QuoteMeta(search), "$options": "i"}}, {"_id": search}, {"ownerId": search}, {"resourceId": search}}
		}
	}
	if v := values["before"]; !summary && v != nil && v.truthy() {
		if v.kind != 's' || utf16Length(v.scalar) > 200 {
			return bad()
		}
		parts := strings.Split(v.scalar, "|")
		if len(parts) != 2 || !emailCursorID.MatchString(parts[1]) {
			return bad()
		}
		stamp, valid, err := javascriptDateValue(parts[0])
		if err != nil || !valid {
			return bad()
		}
		cursor := []M{{"createdAt": M{"$lt": stamp}}, {"createdAt": stamp, "_id": M{"$lt": parts[1]}}}
		if filter["$or"] != nil {
			filter["$and"] = []M{{"$or": cursor}}
		} else {
			filter["$or"] = cursor
		}
	}
	return filter, period, nil
}
func (s *Server) adminEmailHistory(q *request) (any, error) {
	q.W.Header().Set("Cache-Control", "no-store")
	summary := strings.TrimSuffix(q.R.URL.Path, "/") == "/api/admin/emails/summary"
	filter, period, err := emailHistoryFilters(q.R.URL.RawQuery, summary, time.Now())
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(q.ctx(), 5*time.Second)
	defer cancel()
	if !summary {
		projection := M{}
		for _, key := range []string{"_id", "kind", "recipient", "ownerId", "resourceId", "resourceKind", "createdAt", "completedAt", "state", "httpStatus"} {
			projection[key] = 1
		}
		cursor, err := s.Store.DB.Collection(emailDeliveryHistory).Find(ctx, filter, options.Find().SetProjection(projection).SetSort(bson.D{{Key: "createdAt", Value: -1}, {Key: "_id", Value: -1}}).SetLimit(51))
		if err != nil {
			return nil, fail("Email history is unavailable. Try again.", 503)
		}
		defer cursor.Close(ctx)
		rows := []M{}
		if err = cursor.All(ctx, &rows); err != nil {
			return nil, fail("Email history is unavailable. Try again.", 503)
		}
		var next any
		if len(rows) > 50 {
			rows = rows[:50]
			last := rows[49]
			next = date(last["createdAt"]).UTC().Format("2006-01-02T15:04:05.000Z") + "|" + str(last["_id"])
		}
		return M{"entries": rows, "nextCursor": next}, nil
	}
	pipeline := []M{{"$match": filter}, {"$facet": M{"counts": []M{{"$group": M{"_id": "$state", "count": M{"$sum": 1}}}}, "daily": []M{{"$match": M{"createdAt": M{"$gte": period.start}}}, {"$group": M{"_id": M{"date": M{"$dateToString": M{"format": "%Y-%m-%d", "date": "$createdAt", "timezone": "UTC"}}, "state": "$state"}, "count": M{"$sum": 1}}}}}}}
	cursor, err := s.Store.DB.Collection(emailDeliveryHistory).Aggregate(ctx, pipeline)
	if err != nil {
		return nil, fail("Email history summary is unavailable. Try again.", 503)
	}
	defer cursor.Close(ctx)
	rows := []M{}
	if err = cursor.All(ctx, &rows); err != nil {
		return nil, fail("Email history summary is unavailable. Try again.", 503)
	}
	data := M{}
	if len(rows) > 0 {
		data = rows[0]
	}
	counts := emptyEmailCounts()
	total := int64(0)
	for _, value := range arr(data["counts"]) {
		row := obj(value)
		key := str(row["_id"])
		if _, exists := counts[key]; exists {
			counts[key] = number(row["count"])
			total += number(row["count"])
		}
	}
	series := []M{}
	days := map[string]M{}
	for i := 0; i < period.days; i++ {
		day := period.start.AddDate(0, 0, i).Format("2006-01-02")
		point := emptyEmailCounts()
		point["date"] = day
		days[day] = point
		series = append(series, point)
	}
	for _, value := range arr(data["daily"]) {
		row := obj(value)
		id := obj(row["_id"])
		point := days[str(id["date"])]
		key := str(id["state"])
		if point != nil {
			if _, exists := counts[key]; exists {
				point[key] = number(row["count"])
			}
		}
	}
	return M{"counts": counts, "total": total, "series": series, "chartDays": period.days, "period": period.name}, nil
}
func emptyEmailCounts() M {
	return M{"accepted": int64(0), "rejected": int64(0), "unknown": int64(0), "sending": int64(0)}
}
