package server

import (
	"github.com/redis/go-redis/v9"
	"strconv"
	"strings"
	"time"
)

func (s *Server) errorStats(q *request) (any, error) {
	if s.Store == nil || s.Store.Redis == nil {
		return M{"available": false, "last24h": 0, "prev24h": 0, "severity": M{"error": 0, "warn": 0, "info": 0}, "unique": M{"error": 0, "warn": 0, "info": 0}, "buckets": []M{}, "dropped": s.errorLog.dropped.Load()}, nil
	}
	if err := s.flushErrorLog(q.ctx()); err != nil {
		return nil, err
	}

	now := time.Now().UTC().Truncate(time.Hour)
	p := s.Store.Redis.Pipeline()
	cmds := []*redis.MapStringStringCmd{}
	for i := 47; i >= 0; i-- {
		cmds = append(cmds, p.HGetAll(q.ctx(), "admin:errors:hourly:"+now.Add(-time.Duration(i)*time.Hour).Format("2006010215")))
	}
	if _, e := p.Exec(q.ctx()); e != nil {
		return nil, e
	}
	var current, previous int64
	severity := M{"error": int64(0), "warn": int64(0), "info": int64(0)}
	codes := map[string]map[string]bool{"error": {}, "warn": {}, "info": {}}
	buckets := []M{}
	for i, c := range cmds {
		row := c.Val()
		total, _ := strconv.ParseInt(row["total"], 10, 64)
		if i < 24 {
			previous += total
			continue
		}
		current += total
		bucket := M{"hour": now.Add(time.Duration(i-46) * time.Hour).UnixMilli()}
		for _, level := range []string{"error", "warn", "info"} {
			n, _ := strconv.ParseInt(row["bucket:"+level], 10, 64)
			severity[level] = number(severity[level]) + n
			bucket[level] = n
		}
		for k := range row {
			if strings.HasPrefix(k, "cb:") {
				parts := strings.SplitN(k, ":", 3)
				if len(parts) == 3 && codes[parts[1]] != nil {
					codes[parts[1]][parts[2]] = true
				}
			}
		}
		buckets = append(buckets, bucket)
	}
	dropped, _ := s.Store.Redis.Get(q.ctx(), "admin:errors:dropped").Int64()
	return M{"available": true, "last24h": current, "prev24h": previous, "severity": severity, "unique": M{"error": len(codes["error"]), "warn": len(codes["warn"]), "info": len(codes["info"])}, "buckets": buckets, "dropped": dropped + s.errorLog.dropped.Load()}, nil
}
func (s *Server) overview(q *request) (any, error) {
	raw, e := s.adminStats(q)
	if e != nil {
		return nil, e
	}
	stats := obj(raw)
	total, e := s.Store.DB.Collection(collection("repo")).CountDocuments(q.ctx(), M{})
	if e != nil {
		return nil, e
	}
	since := time.Now().Add(-24 * time.Hour)
	active, e := s.Store.DB.Collection(collection("repo")).CountDocuments(q.ctx(), M{"lastView": M{"$gte": since}})
	if e != nil {
		return nil, e
	}
	newRepos, e := s.Store.DB.Collection(collection("repo")).CountDocuments(q.ctx(), M{"anonymizeDate": M{"$gte": since}})
	if e != nil {
		return nil, e
	}
	newUsers, e := s.Store.DB.Collection("users").CountDocuments(q.ctx(), M{"dateOfEntry": M{"$gte": since}})
	if e != nil {
		return nil, e
	}
	queuesRaw, e := s.adminQueues(q)
	if e != nil {
		return nil, e
	}
	queues := M{}
	for _, r := range arr(obj(queuesRaw)["queues"]) {
		v := obj(r)
		queues[str(v["key"])] = v["counts"]
	}
	// Admin history is always the last 30 UTC days and uses fresh totals.
	// Public /stat history has separate caching and caller-selected windows.
	history := []M{}
	if current, err := s.computeStats(q.ctx()); err == nil {
		if rows, err := s.statsHistory(q.ctx(), 30, current, time.Now()); err == nil {
			history = rows
		}
	}
	errorSummary := M{"last24h": int64(0), "severity": M{"error": int64(0), "warn": int64(0), "info": int64(0)}}
	if values, err := s.errorStats(q); err == nil {
		errorSummary = selectFields(obj(values), "last24h", "severity")
	}
	return M{"system": systemOverview(s.started), "repos": M{"total": total, "statusBreakdown": stats["statusBreakdown"], "totalStorage": stats["totalStorage"], "recentErrors24h": stats["recentErrors24h"], "activeRepos24h": active, "newRepos24h": newRepos}, "users": M{"total": stats["totalUsers"], "newUsers24h": newUsers}, "conferences": M{"total": stats["totalConferences"]}, "queues": queues, "errors": errorSummary, "history": history}, nil
}
func (s *Server) adminGitHub(q *request) (any, error) {
	r, e := q.resource("repo", false)
	if e != nil {
		return nil, e
	}
	source := obj(r["source"])
	id, e := sourceProvider(source)
	if e != nil {
		return nil, e
	}
	if id != "github" {
		return nil, fail("provider_capability_not_supported", 400)
	}
	name := str(source["repositoryName"])
	if !safeRepositoryName(name) {
		return nil, fail("invalid_source_repository", 400)
	}
	parts := strings.Split(name, "/")
	out := M{"source": M{"owner": parts[0], "repo": parts[1], "branch": source["branch"], "commit": source["commit"]}}
	token, e := s.boundToken(q.ctx(), r["owner"], obj(r["githubAccess"]), name)
	if e != nil {
		out["repositoryError"] = "github_access_unavailable"
		return out, nil
	}
	repo, e := s.githubObject(q.ctx(), "GET", "/repos/"+name, token, nil)
	if e != nil {
		out["repositoryError"] = "github_repository_unavailable"
	} else {
		out["repository"] = M{"fullName": repo["full_name"], "private": repo["private"], "archived": repo["archived"], "disabled": repo["disabled"], "defaultBranch": repo["default_branch"], "description": repo["description"], "stargazers": repo["stargazers_count"], "watchers": repo["watchers_count"], "forks": repo["forks_count"], "openIssues": repo["open_issues_count"], "size": repo["size"], "language": repo["language"], "license": obj(repo["license"])["spdx_id"], "createdAt": repo["created_at"], "updatedAt": repo["updated_at"], "pushedAt": repo["pushed_at"], "htmlUrl": repo["html_url"], "topics": repo["topics"]}
	}
	branch, e := s.githubObject(q.ctx(), "GET", "/repos/"+name+"/branches/"+segment(str(source["branch"])), token, nil)
	if e == nil {
		out["branch"] = M{"name": branch["name"], "protected": branch["protected"], "commitSha": obj(branch["commit"])["sha"]}
	} else {
		out["branchError"] = "github_branch_unavailable"
	}
	commit, e := s.githubObject(q.ctx(), "GET", "/repos/"+name+"/commits/"+segment(str(source["commit"])), token, nil)
	if e == nil {
		out["commit"] = M{"sha": commit["sha"], "message": obj(commit["commit"])["message"], "author": obj(commit["commit"])["author"], "committer": obj(commit["commit"])["committer"], "htmlUrl": commit["html_url"], "stats": commit["stats"], "filesChanged": len(arr(commit["files"]))}
	} else {
		out["commitError"] = "github_commit_unavailable"
	}
	return out, nil
}
