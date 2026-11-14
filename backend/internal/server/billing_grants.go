package server

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
)

func (s *Server) syncBillingSubscription(ctx context.Context, id string) error {
	for retry := 0; retry < 4; retry++ {
		previous, err := s.Store.one(ctx, "billinggrants", M{"_id": id})
		if err != nil {
			return err
		}
		sub, err := s.stripe(ctx, "GET", "/subscriptions/"+segment(id), M{"expand": []string{"latest_invoice"}}, "")
		if err != nil {
			return err
		}
		metadata := obj(sub["metadata"])
		owner := str(metadata["owner"])
		if owner == "" || metadata["application"] != "anonymous-github" {
			return nil
		}
		account, err := s.Store.one(ctx, "billingaccounts", M{"_id": owner})
		if err != nil {
			return err
		}
		if account == nil || account["customerId"] != stripeRef(sub["customer"]) {
			return fail("billing_customer_mismatch", 400)
		}
		items := arr(obj(sub["items"])["data"])
		item := M{}
		if len(items) > 0 {
			item = obj(items[0])
		}
		price := stripeRef(item["price"])
		plan, err := s.billingPlanForPrice(ctx, price, true)
		if err != nil {
			return err
		}
		invoice := obj(sub["latest_invoice"])
		paid := plan != nil && len(items) == 1 && sub["status"] == "active" && invoice["status"] == "paid"
		paidThrough := date(previous["until"])
		if paidThrough.IsZero() {
			paidThrough = time.Unix(0, 0)
		}
		if paid && number(item["current_period_end"]) > 0 {
			paidThrough = time.Unix(number(item["current_period_end"]), 0)
		}
		if !paid && plan != nil && len(items) == 1 {
			err = s.stripeEach(ctx, "/invoices", M{"subscription": id, "status": "paid"}, func(invoice M) error {
				return s.stripeEach(ctx, "/invoices/"+segment(str(invoice["id"]))+"/lines", nil, func(line M) error {
					details := obj(obj(line["parent"])["subscription_item_details"])
					end := time.Unix(number(obj(line["period"])["end"]), 0)
					if !boolean(details["proration"]) && number(line["amount"]) >= 0 && details["subscription_item"] == item["id"] && end.After(paidThrough) {
						paidThrough = end
					}
					return nil
				})
			})
			if err != nil {
				return err
			}
		}
		planID := "unknown"
		if plan != nil {
			planID = plan.ID
		}
		values := M{"owner": owner, "scope": "user:" + owner, "planId": planID, "customerId": account["customerId"], "priceId": price, "subscriptionId": id, "status": sub["status"], "cancelAtPeriodEnd": boolean(sub["cancel_at_period_end"]) || number(sub["cancel_at"]) > 0, "until": paidThrough}
		if number(sub["start_date"]) > 0 {
			values["purchasedAt"] = time.Unix(number(sub["start_date"]), 0)
		}
		if str(previous["salePriceId"]) == "" && invoice["status"] == "paid" && invoice["billing_reason"] == "subscription_create" {
			err = s.stripeEach(ctx, "/invoices/"+segment(str(invoice["id"]))+"/lines", nil, func(line M) error {
				details := obj(obj(line["parent"])["subscription_item_details"])
				price := stripeRef(obj(obj(line["pricing"])["price_details"])["price"])
				if !boolean(details["proration"]) && details["subscription_item"] == item["id"] && price != "" {
					plan, e := s.billingPlanForPrice(ctx, price, true)
					if e != nil {
						return e
					}
					if plan != nil {
						values["salePriceId"], values["salePlanId"] = price, plan.ID
					}
					return errBillingStop
				}
				return nil
			})
			if err != nil && err != errBillingStop {
				return err
			}
		}
		if previous == nil {
			values["_id"], values["revision"], values["revoked"] = id, 0, false
			_, err = s.Store.DB.Collection("billinggrants").InsertOne(ctx, values)
			if err == nil {
				return nil
			}
			if !mongo.IsDuplicateKeyError(err) {
				return err
			}
		} else {
			filter := M{"_id": id, "revision": previous["revision"]}
			result, e := s.Store.DB.Collection("billinggrants").UpdateOne(ctx, filter, M{"$set": values, "$inc": M{"revision": 1}})
			if e != nil {
				return e
			}
			if result.MatchedCount == 1 {
				return nil
			}
		}
	}
	return fail("billing_busy", 409)
}
func (s *Server) fulfillBillingCheckout(ctx context.Context, id string) error {
	session, err := s.stripe(ctx, "GET", "/checkout/sessions/"+segment(id), M{"expand": []string{"line_items", "payment_intent.latest_charge"}}, "")
	if err != nil {
		return err
	}
	metadata := obj(session["metadata"])
	if metadata["application"] != "anonymous-github" {
		return nil
	}
	owner, planID, target := str(metadata["owner"]), str(metadata["planId"]), str(metadata["target"])
	account, err := s.Store.one(ctx, "billingaccounts", M{"_id": owner})
	if err != nil {
		return err
	}
	if account == nil || account["customerId"] != stripeRef(session["customer"]) {
		return fail("billing_customer_mismatch", 400)
	}
	if session["status"] != "complete" {
		return nil
	}
	if subscription := stripeRef(session["subscription"]); subscription != "" {
		return s.syncBillingSubscription(ctx, subscription)
	}
	plan := s.Config.Billing.plan(planID)
	items := arr(obj(session["line_items"])["data"])
	if plan == nil || plan.Recurring || len(items) != 1 || number(obj(items[0])["quantity"]) != 1 {
		return fail("billing_invalid_purchase", 400)
	}
	priceID := stripeRef(obj(items[0])["price"])
	accepted, err := s.billingPlanForPrice(ctx, priceID, false)
	if err != nil {
		return err
	}
	scope := "repo:" + target
	if conferencePlan(planID) {
		scope = "conference:" + target
	}
	if accepted == nil || accepted.ID != planID {
		previous, e := s.Store.one(ctx, "billinggrants", M{"_id": id})
		if e != nil {
			return e
		}
		if previous == nil || previous["owner"] != owner || previous["customerId"] != account["customerId"] || previous["planId"] != planID || previous["scope"] != scope || (str(previous["priceId"]) != "" && previous["priceId"] != priceID) {
			return fail("billing_invalid_purchase", 400)
		}
	}
	if priceID == "" {
		return fail("billing_invalid_purchase", 400)
	}
	if err = s.billingUpsert(ctx, "billingprices", M{"_id": priceID}, M{"$setOnInsert": M{"planId": planID}}); err != nil {
		return err
	}
	if session["payment_status"] != "paid" {
		return nil
	}
	intent := obj(session["payment_intent"])
	charge := obj(intent["latest_charge"])
	revoked := boolean(charge["refunded"]) || boolean(charge["disputed"])
	purchased := time.Unix(number(session["created"]), 0)
	conferenceEnd := time.Time{}
	if conferencePlan(planID) {
		conference, e := s.Store.one(ctx, "conferences", M{"conferenceID": target})
		if e != nil {
			return e
		}
		if conference == nil {
			return nil
		}
		conferenceEnd = date(conference["endDate"])
	}
	reversal, err := s.Store.one(ctx, "billingrevocations", M{"_id": stripeRef(session["payment_intent"])})
	if err != nil {
		return err
	}
	parts := []string{planID}
	if planID == "repo_pack" {
		parts = billingPack
	}
	// Serializing extensions prevents concurrent purchases from losing a year.
	return s.billingLock(ctx, "fulfill:"+scope, func(work context.Context) error {
		for _, part := range parts {
			grantID := id
			if planID == "repo_pack" {
				grantID += ":" + part
			}
			until := purchased.Add(180 * 24 * time.Hour)
			if part == "repo_never" || part == "repo_slot" {
				until = billingNeverUntil
			}
			if part == "repo_extend" {
				earlier, e := s.Store.list(work, "billinggrants", M{"_id": M{"$ne": grantID}, "scope": scope, "owner": owner, "planId": "repo_extend"}, 0, nil)
				if e != nil {
					return e
				}
				base := purchased
				for _, g := range earlier {
					if usableBillingGrant(g, purchased) && date(g["until"]).After(base) {
						base = date(g["until"])
					}
				}
				until = base.Add(365 * 24 * time.Hour)
			}
			if !conferenceEnd.IsZero() {
				until = conferenceEnd
			}
			values := M{"owner": owner, "scope": scope, "planId": part, "customerId": account["customerId"], "paymentIntentId": stripeRef(session["payment_intent"]), "priceId": priceID, "status": "paid", "until": until, "purchasedAt": purchased, "revision": 0}
			update := M{"$setOnInsert": values}
			// Never clear a stored reversal on a duplicate delivery.
			if boolean(reversal["reviewed"]) {
				update["$set"] = M{"revoked": false}
			} else if reversal != nil {
				update["$set"] = M{"revoked": true, "revocationReason": reversal["reason"]}
			} else if revoked {
				update["$set"] = M{"revoked": true}
			} else {
				values["revoked"] = false
			}
			if err := s.billingUpsert(work, "billinggrants", M{"_id": grantID}, update); err != nil {
				return err
			}
			grant, e := s.Store.one(work, "billinggrants", M{"_id": grantID})
			if e != nil {
				return e
			}
			if part == "repo_slot" && !boolean(grant["revoked"]) {
				if _, e = s.Store.update(work, "billingquotas", M{"_id": "user:" + owner}, M{"$pull": M{"allocations": M{"repoId": target}}}); e != nil {
					return e
				}
			}
			if conferencePlan(planID) && !boolean(grant["revoked"]) {
				if _, e = s.Store.update(work, "conferences", M{"conferenceID": target, "status": "pending_payment", "plan.planID": planID}, M{"$set": M{"status": "ready"}}); e != nil {
					return e
				}
			}
		}
		return nil
	})
}
