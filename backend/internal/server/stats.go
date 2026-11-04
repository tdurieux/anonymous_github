package server

import (
	"context"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"io"
	"os"
	"sort"
	"time"
)

func (s *Server) computeStats(ctx context.Context) (M, error) {
	repos, e := s.Store.DB.Collection(collection("repo")).CountDocuments(ctx, M{})
	if e != nil {
		return nil, e
	}
	prs, e := s.Store.DB.Collection(collection("pr")).CountDocuments(ctx, M{})
	if e != nil {
		return nil, e
	}
	cursor, e := s.Store.DB.Collection(collection("repo")).Aggregate(ctx, []M{{"$group": M{"_id": "$owner", "views": M{"$sum": "$pageView"}}}, {"$group": M{"_id": nil, "users": M{"$sum": 1}, "views": M{"$sum": "$views"}}}})
	if e != nil {
		return nil, e
	}
	defer cursor.Close(ctx)
	var usage M
	if cursor.Next(ctx) {
		if e = cursor.Decode(&usage); e != nil {
			return nil, e
		}
	}
	if e = cursor.Err(); e != nil {
		return nil, e
	}
	return M{"nbRepositories": repos, "nbPullRequests": prs, "nbUsers": number(usage["users"]), "nbPageViews": number(usage["views"])}, nil
}
func (s *Server) stats(q *request) (any, error) {
	if q.R.URL.Path == "/api/stat" {
		return s.getCurrentStats(q.ctx())
	}
	raw, err := extendedQueryString(q.R.URL.RawQuery, "days")
	if err != nil {
		return nil, err
	}
	return s.getStatsHistory(q.ctx(), publicStatsDays(raw), time.Now())
}

func mergeCurrentStats(rows []M, current M, now time.Time) []M {
	today := now.UTC().Truncate(24 * time.Hour)
	out := make([]M, 0, len(rows)+1)
	replaced := false
	for _, row := range rows {
		copy := selectFields(row, "date", "nbRepositories", "nbUsers", "nbPageViews", "nbPullRequests")
		copy["date"] = date(row["date"]).UTC()
		if !replaced && date(row["date"]).UTC().Truncate(24*time.Hour).Equal(today) {
			copy = selectFields(current, "nbRepositories", "nbUsers", "nbPageViews", "nbPullRequests")
			copy["date"] = today
			replaced = true
		}
		out = append(out, copy)
	}
	if !replaced {
		row := selectFields(current, "nbRepositories", "nbUsers", "nbPageViews", "nbPullRequests")
		row["date"] = today
		out = append(out, row)
	}
	sort.SliceStable(out, func(i, j int) bool { return date(out[i]["date"]).Before(date(out[j]["date"])) })
	return out
}
func (s *Server) statsHistory(ctx context.Context, days int64, current M, now time.Time) ([]M, error) {
	today := now.UTC().Truncate(24 * time.Hour)
	// The window bounds dates, not row count. Legacy snapshots can include
	// several distinct timestamps per day and must not be silently truncated.
	rows, err := s.Store.list(ctx, "dailystats", M{"date": M{"$gte": today.AddDate(0, 0, -int(days)+1)}}, 0, bson.D{{Key: "date", Value: 1}})
	if err != nil {
		return nil, err
	}
	return mergeCurrentStats(rows, current, now), nil
}

func (s *Server) snapshotStats(ctx context.Context) error {
	now := time.Now().UTC().Truncate(24 * time.Hour)
	exists, e := s.Store.one(ctx, "dailystats", M{"date": now})
	if e != nil || exists != nil {
		return e
	}
	stats, e := s.computeStats(ctx)
	if e != nil {
		return e
	}
	stats["date"] = now
	_, e = s.Store.DB.Collection("dailystats").UpdateOne(ctx, M{"date": now}, M{"$setOnInsert": stats}, options.UpdateOne().SetUpsert(true))
	return e
}
func (s *Server) message(q *request) (any, error) {
	f, e := os.Open("message.txt")
	if os.IsNotExist(e) {
		return nil, fail("not_found", 404)
	}
	if e != nil {
		return nil, e
	}
	defer f.Close()
	q.W.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if q.R.Method != "HEAD" {
		_, e = io.Copy(q.W, io.LimitReader(f, 1024*1024))
	}
	return written{}, e
}
