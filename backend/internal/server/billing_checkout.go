package server

import (
	"context"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

var billingRepoID = regexp.MustCompile(`^[0-9a-zA-Z_-]{3,200}$`)
var billingDraftReturn = regexp.MustCompile(`^/anonymize(?:/[A-Za-z0-9_-]{1,200})?\?billingDraft=[a-f0-9-]{36}$`)

func (s *Server) createBillingCheckout(ctx context.Context, owner, planID, target, returnPath string) (string, error) {
	if err := s.Config.Billing.require(); err != nil {
		return "", err
	}
	if !s.Config.Billing.Checkout {
		return "", fail("billing_checkout_disabled", 503)
	}
	plan := s.Config.Billing.plan(planID)
	if plan == nil || plan.PriceID == "" {
		return "", fail("billing_plan_unavailable", 400)
	}
	if conferencePlan(planID) {
		oid, err := oid(owner)
		if err != nil {
			return "", err
		}
		conference, err := s.Store.one(ctx, "conferences", M{"conferenceID": target, "owners": oid})
		if err != nil {
			return "", err
		}
		if conference == nil || obj(conference["plan"])["planID"] != planID || conference["status"] != "pending_payment" {
			return "", fail("billing_invalid_conference", 400)
		}
		if !date(conference["endDate"]).After(time.Now()) || date(conference["endDate"]).Sub(date(conference["startDate"])) > 180*24*time.Hour {
			return "", fail("billing_invalid_review_window", 400)
		}
	} else if !plan.Recurring {
		if !billingRepoID.MatchString(target) {
			return "", fail("repo_not_found", 404)
		}
		repo, err := s.Store.one(ctx, collection("repo"), M{"repoId": target})
		if err != nil {
			return "", err
		}
		if repo != nil {
			if str(repo["owner"]) != owner || repo["status"] == "removed" {
				return "", fail("repo_not_found", 404)
			}
			target = str(repo["repoId"])
		}
	} else {
		target = ""
	}
	destination := "/profile"
	if conferencePlan(planID) {
		destination = "/conference/" + url.PathEscape(target)
	}
	if returnPath != "" {
		if !billingDraftReturn.MatchString(returnPath) {
			return "", fail("billing_invalid_draft", 400)
		}
		destination = returnPath
	}
	outcome := func(value string) string {
		separator := "?"
		if strings.Contains(destination, "?") {
			separator = "&"
		}
		return strings.TrimSuffix(s.Config.Billing.Origin, "/") + destination + separator + "billing=" + value
	}
	result := ""
	err := s.billingLock(ctx, "checkout:"+owner, func(work context.Context) error {
		if err := s.billingUpsert(work, "billingaccounts", M{"_id": owner}, M{"$setOnInsert": M{"reconcileAfter": time.Unix(0, 0)}}); err != nil {
			return err
		}
		account, err := s.Store.one(work, "billingaccounts", M{"_id": owner})
		if err != nil {
			return err
		}
		save := func(values M) error {
			_, e := s.Store.update(work, "billingaccounts", M{"_id": owner}, M{"$set": values})
			return e
		}
		if str(account["customerId"]) == "" {
			attempted := date(account["customerAttemptAt"])
			if !attempted.IsZero() && time.Since(attempted) >= 23*time.Hour {
				return fail("billing_recovery_required", 409)
			}
			if attempted.IsZero() {
				if err = save(M{"customerAttemptAt": time.Now()}); err != nil {
					return err
				}
			}
			customer, e := s.stripe(work, "POST", "/customers", M{"metadata": M{"application": "anonymous-github", "owner": owner}}, "customer:"+owner)
			if e != nil {
				return e
			}
			if str(customer["id"]) == "" {
				return fail("billing_provider_invalid_response", 502)
			}
			account["customerId"] = customer["id"]
			if err = save(M{"customerId": customer["id"]}); err != nil {
				return err
			}
		}
		checkout := obj(account["checkout"])
		if str(checkout["key"]) != "" && str(checkout["id"]) == "" && (date(checkout["createdAt"]).IsZero() || time.Since(date(checkout["createdAt"])) >= 23*time.Hour) {
			err = s.stripeEach(work, "/checkout/sessions", M{"customer": account["customerId"]}, func(row M) error {
				meta := obj(row["metadata"])
				if meta["attempt"] == checkout["key"] && meta["owner"] == owner {
					checkout["id"] = row["id"]
					return errBillingStop
				}
				return nil
			})
			if err != nil && err != errBillingStop {
				return err
			}
			if str(checkout["id"]) != "" {
				if err = save(M{"checkout": checkout}); err != nil {
					return err
				}
			} else {
				expiry := number(obj(checkout["params"])["expires_at"])
				if expiry > 0 && !date(checkout["createdAt"]).IsZero() && time.Since(date(checkout["createdAt"])) > 24*time.Hour && expiry < time.Now().Unix() {
					checkout = M{}
					if _, err = s.Store.update(work, "billingaccounts", M{"_id": owner}, M{"$unset": M{"checkout": 1}}); err != nil {
						return err
					}
				} else {
					return fail("billing_recovery_required", 409)
				}
			}
		}
		params := obj(checkout["params"])
		if str(params["success_url"]) != "" && str(checkout["id"]) == "" && params["success_url"] != outcome("success") {
			return fail("billing_checkout_in_progress", 409)
		}
		if id := str(checkout["id"]); id != "" {
			existing, e := s.stripe(work, "GET", "/checkout/sessions/"+segment(id), nil, "")
			if e != nil {
				return e
			}
			if existing["status"] == "open" {
				if checkout["planId"] != planID || checkout["target"] != target || (str(params["success_url"]) != "" && params["success_url"] != outcome("success")) {
					return fail("billing_checkout_in_progress", 409)
				}
				result = str(existing["url"])
				return nil
			}
			if existing["status"] == "complete" {
				if e = s.fulfillBillingCheckout(work, id); e != nil {
					return e
				}
			}
		}
		price, err := s.stripe(work, "GET", "/prices/"+segment(plan.PriceID), nil, "")
		if err != nil {
			return err
		}
		interval := "year"
		if planID == "author_monthly" {
			interval = "month"
		}
		recurring := obj(price["recurring"])
		if !boolean(price["active"]) || price["currency"] != "eur" || number(price["unit_amount"]) <= 0 || (plan.Recurring && (recurring["interval"] != interval || number(recurring["interval_count"]) != 1)) || (!plan.Recurring && len(recurring) > 0) {
			return fail("billing_price_misconfigured", 503)
		}
		if plan.Recurring {
			err = s.stripeEach(work, "/subscriptions", M{"customer": account["customerId"], "status": "all"}, func(sub M) error {
				if sub["status"] != "canceled" && sub["status"] != "incomplete_expired" {
					return fail("billing_subscription_exists", 409)
				}
				return nil
			})
			if err != nil {
				return err
			}
		} else if conferencePlan(planID) || (planID != "repo_extend" && planID != "repo_pack") {
			filter := M{"scope": "repo:" + target, "owner": owner, "planId": planID, "revoked": false, "until": M{"$gt": time.Now()}}
			if conferencePlan(planID) {
				filter = M{"scope": "conference:" + target, "revoked": false, "until": M{"$gt": time.Now()}}
			}
			grant, e := s.Store.one(work, "billinggrants", filter)
			if e != nil {
				return e
			}
			if grant != nil {
				return fail("billing_already_paid", 409)
			}
		}
		if str(checkout["key"]) == "" || str(checkout["id"]) != "" {
			checkout = M{"key": uuid.NewString(), "planId": planID, "target": target, "createdAt": time.Now(), "expiresAt": time.Now().Add(1860 * time.Second)}
			if err = save(M{"checkout": checkout}); err != nil {
				return err
			}
		}
		if checkout["planId"] != planID || checkout["target"] != target {
			return fail("billing_checkout_in_progress", 409)
		}
		params = obj(checkout["params"])
		if len(params) == 0 {
			metadata := M{"application": "anonymous-github", "owner": owner, "planId": planID, "target": target, "attempt": checkout["key"]}
			params = M{"customer": account["customerId"], "expires_at": time.Now().Unix() + 1860, "mode": "payment", "line_items": []M{{"price": plan.PriceID, "quantity": 1}}, "allowed_payment_method_types": []string{"card"}, "metadata": metadata, "billing_address_collection": "required", "tax_id_collection": M{"enabled": true}, "customer_update": M{"address": "auto", "name": "auto"}, "automatic_tax": M{"enabled": s.Config.Billing.AutomaticTax}, "success_url": outcome("success"), "cancel_url": outcome("cancelled")}
			if plan.Recurring {
				params["mode"] = "subscription"
				params["subscription_data"] = M{"metadata": metadata}
			} else {
				params["payment_intent_data"] = M{"metadata": metadata}
				params["invoice_creation"] = M{"enabled": true}
			}
			checkout["params"] = params
			if err = save(M{"checkout": checkout}); err != nil {
				return err
			}
		}
		lines := arr(params["line_items"])
		if len(lines) > 0 {
			if err = s.billingUpsert(work, "billingprices", M{"_id": obj(lines[0])["price"]}, M{"$setOnInsert": M{"planId": planID}}); err != nil {
				return err
			}
		}
		session, err := s.stripe(work, "POST", "/checkout/sessions", params, str(checkout["key"]))
		if err != nil {
			return err
		}
		if str(session["id"]) == "" || str(session["url"]) == "" {
			return fail("billing_provider_invalid_response", 502)
		}
		checkout["id"] = session["id"]
		if err = save(M{"checkout": checkout}); err != nil {
			return err
		}
		result = str(session["url"])
		return nil
	})
	return result, err
}
