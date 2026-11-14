package server

import (
	"context"
	"time"
)

func billingMonthLimit(now time.Time, months int) time.Time {
	next := now.In(time.Local).AddDate(0, months, 0)
	return time.Date(next.Year(), next.Month(), next.Day(), 23, 59, 59, 999000000, next.Location())
}
func (s *Server) billingMaximumExpiration(ctx context.Context, owner, repoID, conference string, now time.Time) (time.Time, error) {
	if !s.Config.Billing.Enabled {
		return billingMonthLimit(now, 12), nil
	}
	maximum := billingMonthLimit(now, int(s.Config.Billing.FreeMonths))
	if conference != "" {
		row, err := s.Store.one(ctx, "conferences", M{"conferenceID": conference})
		if err != nil {
			return time.Time{}, err
		}
		if end := date(row["endDate"]); end.After(maximum) {
			maximum = end
		}
	}
	grants, err := s.Store.list(ctx, "billinggrants", M{"$or": []M{{"scope": "user:" + owner, "planId": M{"$in": []string{"author_monthly", "author_annual"}}}, {"scope": "repo:" + repoID, "owner": owner, "planId": "repo_extend"}}}, 0, nil)
	if err != nil {
		return time.Time{}, err
	}
	for _, grant := range grants {
		if !usableBillingGrant(grant, now) {
			continue
		}
		limit := billingMonthLimit(now, 12)
		if grant["planId"] == "repo_extend" {
			until := date(grant["until"]).In(time.Local)
			limit = time.Date(until.Year(), until.Month(), until.Day(), 23, 59, 59, 999000000, until.Location())
		}
		if limit.After(maximum) {
			maximum = limit
		}
	}
	return maximum, nil
}
func (s *Server) billingNeverDeadline(ctx context.Context, owner, repoID string, existing time.Time) (time.Time, error) {
	if !s.Config.Billing.Enabled {
		return time.Time{}, nil
	}
	now := time.Now()
	grants, err := s.Store.list(ctx, "billinggrants", M{"$or": []M{{"scope": "user:" + owner, "planId": M{"$in": []string{"author_monthly", "author_annual"}}}, {"scope": "repo:" + repoID, "owner": owner, "planId": "repo_never"}}}, 0, nil)
	if err != nil {
		return time.Time{}, err
	}
	deadline := existing
	for _, grant := range grants {
		if !usableBillingGrant(grant, now) {
			continue
		}
		until := date(grant["until"])
		if grant["planId"] == "repo_never" {
			until = now
		}
		until = until.Add(90 * 24 * time.Hour)
		if until.After(deadline) {
			deadline = until
		}
	}
	if !deadline.After(now) {
		return time.Time{}, fail("subscription_required_for_never_expiration", 402)
	}
	return deadline, nil
}
func (s *Server) billingResourceSettings(ctx context.Context, owner, repoID, conference string, opt, previous M) (M, error) {
	set := M{}
	if !s.Config.Billing.Enabled {
		return set, nil
	}
	if opt["expirationMode"] == "never" {
		existing := time.Time{}
		if obj(previous["options"])["expirationMode"] == "never" {
			existing = date(previous["billingNeverExpiresUntil"])
		}
		deadline, err := s.billingNeverDeadline(ctx, owner, repoID, existing)
		if err != nil {
			return nil, err
		}
		set["billingNeverExpiresUntil"] = deadline
	} else {
		maximum, err := s.billingMaximumExpiration(ctx, owner, repoID, conference, time.Now())
		if err != nil {
			return nil, err
		}
		value := date(opt["expirationDate"])
		unchanged := value.Equal(date(obj(previous["options"])["expirationDate"]))
		if (opt["expirationMode"] != "remove" && opt["expirationMode"] != "redirect") || value.IsZero() || (value.After(maximum) && !unchanged) {
			return nil, fail("invalid_billing_expiration", 400)
		}
	}
	set["billingManaged"] = true
	return set, nil
}
