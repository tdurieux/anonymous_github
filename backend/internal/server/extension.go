package server

import (
	"context"
	"time"
)

func (s *Server) extendResource(ctx context.Context, kind string, r M) (M, error) {
	switch str(r["status"]) {
	case "archived":
		return nil, fail("repository_archived", 410)
	case "preparing", "removing", "expiring", "removed":
		return nil, fail("invalid_status", 409)
	}
	now := time.Now()
	base := date(obj(r["options"])["expirationDate"])
	if !base.After(now) {
		base = now
	}
	next := base.In(time.Local).AddDate(0, 6, 0)
	set := M{"options.expirationDate": next}
	if kind == "repo" {
		set["settingsSavedAt"] = now
		if str(r["status"]) == "expired" {
			set["status"] = "preparing"
			set["statusDate"] = now
			set["anonymizeDate"] = now
			set["statusMessage"] = nil
		}
	}
	changed, e := s.Store.update(ctx, collection(kind), revisionFilter(r), M{"$set": set})
	if e != nil {
		return nil, e
	}
	if !changed {
		return nil, fail("invalid_status", 409)
	}
	opt := obj(r["options"])
	opt["expirationDate"] = next
	r["options"] = opt
	for k, v := range set {
		if k != "options.expirationDate" {
			r[k] = v
		}
	}
	if kind != "repo" {
		if e = s.refreshEmbedded(ctx, kind, r); e != nil {
			return nil, e
		}
	} else if str(r["status"]) == "preparing" {
		if e = s.enqueueSavedSnapshot(ctx, r); e != nil {
			return nil, e
		}
	}
	return M{"status": r["status"], "expirationDate": next}, nil
}

// The saved snapshot is sufficient for reactivation; no branch lookup is needed.
// A queue failure must not strand preparing resources or overwrite newer work.
func (s *Server) enqueueSavedSnapshot(ctx context.Context, r M) error {
	e := s.enqueue(ctx, "repo", str(r["repoId"]), "prepare")
	if e == nil {
		return nil
	}
	filter := M{"_id": r["_id"], "status": "preparing", "statusDate": r["statusDate"], "anonymizeDate": r["anonymizeDate"]}
	if v, ok := r["settingsSavedAt"]; ok {
		filter["settingsSavedAt"] = v
	}
	field := "githubAccess"
	if id, _ := sourceProvider(obj(r["source"])); id != "github" {
		field = "providerAccess"
	}
	if v, ok := obj(r[field])["revision"]; ok {
		filter[field+".revision"] = v
	} else {
		filter[field+".revision"] = M{"$exists": false}
	}
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	s.Store.update(cleanup, collection("repo"), filter, M{"$set": M{"status": "error", "statusDate": time.Now(), "statusMessage": "preparation_interrupted"}})
	return e
}
