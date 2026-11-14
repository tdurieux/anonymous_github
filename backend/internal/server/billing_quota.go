package server

import (
	"context"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

func (s *Server) billingAllowance(ctx context.Context, owner, repoID, conference string) (M, error) {
	scopes := []string{"user:" + owner}
	if repoID != "" {
		scopes = append(scopes, "repo:"+repoID)
	}
	if conference != "" {
		scopes = append(scopes, "conference:"+conference)
	}
	now := time.Now()
	grants, err := s.Store.list(ctx, "billinggrants", M{"scope": M{"$in": scopes}, "until": M{"$gt": now}, "revoked": false}, 0, nil)
	if err != nil {
		return nil, err
	}
	for i := len(scopes) - 1; i >= 0; i-- {
		scope := scopes[i]
		var chosen *BillingPlan
		for _, grant := range grants {
			if grant["scope"] != scope || !usableBillingGrant(grant, now) || (strings.HasPrefix(scope, "repo:") && grant["owner"] != owner) {
				continue
			}
			plan := s.Config.Billing.plan(str(grant["planId"]))
			if plan != nil && plan.Capacity && (chosen == nil || chosen.ID == "repo_slot") {
				chosen = plan
			}
		}
		if chosen != nil {
			return M{"scope": scope, "repositories": chosen.Repositories, "storage": chosen.Storage, "plan": chosen.ID}, nil
		}
	}
	return M{"scope": "user:" + owner, "repositories": s.Config.Billing.FreeRepositories, "storage": s.Config.Billing.FreeStorage, "plan": "free"}, nil
}
func (s *Server) reserveBillingRepository(ctx context.Context, owner, repoID string, bytes int64, conference, expansionKey string, expansionBytes int64) error {
	if !s.Config.Billing.Enabled {
		return nil
	}
	if bytes < 0 || bytes > 9007199254740991 || expansionBytes < 0 || expansionBytes > 9007199254740991 {
		return fail("billing_invalid_repository_size", 400)
	}
	limits, err := s.billingAllowance(ctx, owner, repoID, conference)
	if err != nil {
		return err
	}
	scope := str(limits["scope"])
	for retry := 0; retry < 10; retry++ {
		ledger, err := s.Store.one(ctx, "billingquotas", M{"_id": scope})
		if err != nil {
			return err
		}
		if ledger == nil {
			filter := M{"status": M{"$nin": []string{"removed", "expired"}}}
			switch {
			case strings.HasPrefix(scope, "user:"):
				ownerID, e := oid(owner)
				if e != nil {
					return e
				}
				filter["owner"] = ownerID
			case strings.HasPrefix(scope, "conference:"):
				filter["conference"] = conference
			default:
				filter["repoId"] = repoID
			}
			repos, e := s.Store.list(ctx, collection("repo"), filter, 0, nil)
			if e != nil {
				return e
			}
			allocations := []M{}
			for _, repo := range repos {
				funding, e := s.billingAllowance(ctx, str(repo["owner"]), str(repo["repoId"]), str(repo["conference"]))
				if e != nil {
					return e
				}
				if funding["scope"] == scope {
					allocations = append(allocations, M{"repoId": repo["repoId"], "reservationId": uuid.NewString(), "bytes": number(obj(repo["size"])["storage"]), "createdAt": time.Now()})
				}
			}
			_, e = s.Store.DB.Collection("billingquotas").InsertOne(ctx, M{"_id": scope, "allocations": allocations})
			if e != nil && !mongo.IsDuplicateKeyError(e) {
				return e
			}
			continue
		}
		original := arr(ledger["allocations"])
		ids := make([]string, 0, len(original))
		for _, value := range original {
			ids = append(ids, str(obj(value)["repoId"]))
		}
		removed, e := s.Store.list(ctx, collection("repo"), M{"repoId": M{"$in": ids}, "status": "removed"}, 0, nil)
		if e != nil {
			return e
		}
		terminal := make(map[string]bool, len(removed))
		for _, row := range removed {
			terminal[str(row["repoId"])] = true
		}
		next := []M{}
		old := M{}
		used := int64(0)
		for _, value := range original {
			allocation := obj(value)
			if allocation["repoId"] == repoID {
				old = allocation
				continue
			}
			if terminal[str(allocation["repoId"])] {
				continue
			}
			size := number(allocation["bytes"])
			if size < 0 || used > math.MaxInt64-size {
				return fail("quota_exceeded", 402)
			}
			used += size
			next = append(next, allocation)
		}
		expansions := []M{}
		oldExtra, newExtra := int64(0), int64(0)
		found := false
		for _, value := range arr(old["expansions"]) {
			entry := obj(value)
			size := number(entry["bytes"])
			if size < 0 || oldExtra > 9007199254740991-size {
				return fail("billing_invalid_repository_size", 400)
			}
			oldExtra += size
			if expansionKey != "" && entry["key"] == expansionKey {
				size = max(size, expansionBytes)
				found = true
			}
			expansions = append(expansions, M{"key": entry["key"], "bytes": size})
			if newExtra > 9007199254740991-size {
				return fail("billing_invalid_repository_size", 400)
			}
			newExtra += size
		}
		if expansionKey != "" && !found {
			expansions = append(expansions, M{"key": expansionKey, "bytes": expansionBytes})
			if newExtra > 9007199254740991-expansionBytes {
				return fail("billing_invalid_repository_size", 400)
			}
			newExtra += expansionBytes
		}
		base := number(old["baseBytes"])
		if _, exists := old["baseBytes"]; !exists {
			base = number(old["bytes"]) - oldExtra
		}
		base = max(base, bytes)
		reserved := base + newExtra
		if reserved < 0 || reserved > 9007199254740991 || int64(len(next)) >= number(limits["repositories"]) || used > number(limits["storage"])-reserved {
			return fail("quota_exceeded", 402)
		}
		next = append(next, M{"repoId": repoID, "reservationId": uuid.NewString(), "bytes": reserved, "baseBytes": base, "expansions": expansions, "createdAt": time.Now()})
		result, e := s.Store.DB.Collection("billingquotas").UpdateOne(ctx, M{"_id": scope, "allocations": ledger["allocations"]}, M{"$set": M{"allocations": next}})
		if e != nil {
			return e
		}
		if result.MatchedCount == 1 {
			return nil
		}
	}
	return fail("billing_busy", 409)
}
func (s *Server) billingConferenceAdmission(ctx context.Context, owner, repoID, conference string) error {
	if !s.Config.Billing.Enabled || conference == "" {
		return nil
	}
	row, err := s.Store.one(ctx, "conferences", M{"conferenceID": conference})
	if err != nil {
		return err
	}
	now := time.Now()
	if row == nil || row["status"] != "ready" || date(row["startDate"]).After(now) || !date(row["endDate"]).After(now) {
		return fail("conf_not_activated", 400)
	}
	if conferencePlan(str(obj(row["plan"])["planID"])) {
		allowance, err := s.billingAllowance(ctx, owner, repoID, conference)
		if err != nil {
			return err
		}
		if allowance["scope"] != "conference:"+conference {
			return fail("conference_payment_required", 402)
		}
	}
	return nil
}
func (s *Server) billingAutomaticUpdates(ctx context.Context, owner, repoID, conference string) (bool, error) {
	if !s.Config.Billing.Enabled {
		return true, nil
	}
	allowance, err := s.billingAllowance(ctx, owner, repoID, conference)
	if err != nil {
		return false, err
	}
	if allowance["plan"] != "free" && allowance["plan"] != "repo_slot" {
		return true, nil
	}
	grants, err := s.Store.list(ctx, "billinggrants", M{"scope": "user:" + owner, "planId": M{"$in": []string{"author_monthly", "author_annual"}}}, 0, nil)
	if err != nil {
		return false, err
	}
	for _, g := range grants {
		if usableBillingGrant(g, time.Now()) {
			return true, nil
		}
	}
	return false, nil
}
