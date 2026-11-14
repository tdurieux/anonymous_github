package server

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func (s *Server) reconcileBillingAccount(ctx context.Context, owner string) error {
	return s.billingLock(ctx, "reconcile:"+owner, func(work context.Context) error {
		account, err := s.Store.one(work, "billingaccounts", M{"_id": owner})
		if err != nil {
			return err
		}
		if str(account["customerId"]) == "" {
			return fail("billing_customer_missing", 400)
		}
		if err = s.stripeEach(work, "/subscriptions", M{"customer": account["customerId"], "status": "all"}, func(sub M) error { return s.syncBillingSubscription(work, str(sub["id"])) }); err != nil {
			return err
		}
		if err = s.stripeEach(work, "/checkout/sessions", M{"customer": account["customerId"]}, func(session M) error {
			meta := obj(session["metadata"])
			if meta["application"] != "anonymous-github" || meta["owner"] != owner {
				return nil
			}
			checkout := obj(account["checkout"])
			if str(checkout["key"]) != "" && str(checkout["id"]) == "" && meta["attempt"] == checkout["key"] {
				if _, err := s.Store.update(work, "billingaccounts", M{"_id": owner, "checkout.key": checkout["key"]}, M{"$set": M{"checkout.id": session["id"]}}); err != nil {
					return err
				}
			}
			if session["status"] == "complete" {
				return s.fulfillBillingCheckout(work, str(session["id"]))
			}
			return nil
		}); err != nil {
			return err
		}
		if err = s.stripeEach(work, "/charges", M{"customer": account["customerId"]}, func(charge M) error {
			if boolean(charge["refunded"]) || boolean(charge["disputed"]) {
				charge["refunded"] = true
				return s.processBillingEvent(work, M{"type": "charge.refunded", "object": charge})
			}
			return nil
		}); err != nil {
			return err
		}
		_, err = s.Store.update(work, "billingaccounts", M{"_id": owner}, M{"$set": M{"reconciledAt": time.Now(), "reconcileAfter": time.Now().Add(24 * time.Hour)}, "$unset": M{"reconcileError": 1}})
		return err
	})
}
func (s *Server) reconcileBillingAccounts(ctx context.Context) error {
	rows, err := s.Store.list(ctx, "billingaccounts", M{"customerId": M{"$exists": true}, "$or": []M{{"reconcileAfter": M{"$lte": time.Now()}}, {"reconcileAfter": M{"$exists": false}}}}, 10, bson.D{{Key: "reconcileAfter", Value: 1}})
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := s.reconcileBillingAccount(ctx, str(row["_id"])); err != nil {
			s.Store.update(ctx, "billingaccounts", M{"_id": row["_id"]}, M{"$set": M{"reconcileAfter": time.Now().Add(15 * time.Minute), "reconcileError": "billing_processing_failed"}})
		}
	}
	_, err = s.Store.DB.Collection("billingevents").DeleteMany(ctx, M{"state": "complete", "completedAt": M{"$lt": time.Now().Add(-90 * 24 * time.Hour)}})
	return err
}
func (s *Server) runBillingMaintenance(ctx context.Context) {
	if !s.Config.Billing.Enabled {
		return
	}
	if err := s.rememberBillingPrices(ctx); err != nil {
		s.recordError(ctx, err)
	}
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	next := time.Time{}
	for {
		if err := s.processBillingInbox(ctx); err != nil && ctx.Err() == nil {
			s.recordError(ctx, err)
		}
		if time.Now().After(next) {
			if err := s.reconcileBillingAccounts(ctx); err != nil && ctx.Err() == nil {
				s.recordError(ctx, err)
			}
			next = time.Now().Add(5 * time.Minute)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (s *Server) cancelAccountBilling(ctx context.Context, owner string) error {
	account, err := s.Store.one(ctx, "billingaccounts", M{"_id": owner})
	if err != nil {
		return err
	}
	if str(account["customerId"]) == "" {
		return nil
	}
	return s.billingLock(ctx, "checkout:"+owner, func(work context.Context) error {
		account, err := s.Store.one(work, "billingaccounts", M{"_id": owner})
		if err != nil {
			return err
		}
		if str(account["customerId"]) == "" {
			return nil
		}
		checkout := obj(account["checkout"])
		if str(checkout["key"]) != "" && str(checkout["id"]) == "" {
			return fail("billing_checkout_in_progress", 409)
		}
		if id := str(checkout["id"]); id != "" {
			session, err := s.stripe(work, "GET", "/checkout/sessions/"+segment(id), nil, "")
			if err != nil {
				return err
			}
			if session["status"] == "open" {
				if _, err = s.stripe(work, "POST", "/checkout/sessions/"+segment(id)+"/expire", nil, ""); err != nil {
					return err
				}
			}
		}
		if err = s.stripeEach(work, "/subscriptions", M{"customer": account["customerId"], "status": "all"}, func(sub M) error {
			if sub["status"] == "canceled" || sub["status"] == "incomplete_expired" {
				return nil
			}
			_, err := s.stripe(work, "DELETE", "/subscriptions/"+segment(str(sub["id"])), nil, "")
			return err
		}); err != nil {
			return err
		}
		_, err = s.Store.DB.Collection("billinggrants").UpdateMany(work, M{"owner": owner, "subscriptionId": M{"$exists": true}}, M{"$set": M{"status": "canceled"}, "$inc": M{"revision": 1}})
		return err
	})
}
func (s *Server) reconcileBillingExpiration(ctx context.Context) error {
	if !s.Config.Billing.Enabled {
		return nil
	}
	cursor, err := s.Store.DB.Collection(collection("repo")).Find(ctx, M{"options.expirationMode": "never", "billingNeverExpiresUntil": M{"$exists": true}, "status": M{"$nin": []string{"removed", "expired", "expiring", "removing"}}})
	if err != nil {
		return err
	}
	defer cursor.Close(ctx)
	for cursor.Next(ctx) {
		var repo M
		if err := cursor.Decode(&repo); err != nil {
			return err
		}
		now := time.Now()
		owner := str(repo["owner"])
		previous := date(repo["billingNeverExpiresUntil"])
		deadline := previous
		refresh := func() error {
			grants, err := s.Store.list(ctx, "billinggrants", M{"$or": []M{{"scope": "user:" + owner, "planId": M{"$in": []string{"author_monthly", "author_annual"}}}, {"scope": "repo:" + str(repo["repoId"]), "owner": owner, "planId": "repo_never"}}}, 0, nil)
			if err != nil {
				return err
			}
			for _, g := range grants {
				if boolean(g["revoked"]) {
					continue
				}
				until := date(g["until"])
				if g["planId"] == "repo_never" {
					if !usableBillingGrant(g, now) || !previous.Before(now.Add(83*24*time.Hour)) {
						continue
					}
					until = now
				}
				if until.IsZero() {
					continue
				}
				until = until.Add(90 * 24 * time.Hour)
				if until.After(deadline) {
					deadline = until
				}
			}
			return nil
		}
		if err := refresh(); err != nil {
			return err
		}
		if !deadline.After(now) {
			if err := s.reconcileBillingAccount(ctx, owner); err != nil {
				continue
			}
			if err := refresh(); err != nil {
				return err
			}
		}
		set := M{"billingNeverExpiresUntil": deadline}
		update := M{"$set": set}
		if !deadline.After(now) {
			set = M{"options.expirationMode": "remove", "options.expirationDate": deadline}
			update = M{"$set": set, "$unset": M{"billingNeverExpiresUntil": 1}}
		}
		if _, err = s.Store.update(ctx, collection("repo"), M{"_id": repo["_id"], "options.expirationMode": "never", "billingNeverExpiresUntil": previous}, update); err != nil {
			return err
		}
	}
	return cursor.Err()
}
