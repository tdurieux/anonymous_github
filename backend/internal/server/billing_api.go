package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/bson"
)

var billingDraftPath = regexp.MustCompile(`^/anonymize(?:/[A-Za-z0-9_-]{1,200})?$`)
var billingDraftID = regexp.MustCompile(`^[a-f0-9-]{36}$`)

func (s *Server) billingDraft(q *request, id string) (M, error) {
	if !billingDraftID.MatchString(id) {
		return nil, fail("billing_draft_not_found", 404)
	}
	draft, err := s.Store.one(q.ctx(), "billingdrafts", M{"_id": id, "owner": q.Identity.ID, "expiresAt": M{"$gt": time.Now()}})
	if err != nil {
		return nil, err
	}
	if draft == nil {
		return nil, fail("billing_draft_not_found", 404)
	}
	return draft, nil
}
func (s *Server) billingAPI(q *request) (any, error) {
	q.W.Header().Set("Cache-Control", "no-store")
	endpoint := strings.TrimPrefix(q.R.URL.Path, "/api/billing")
	if q.R.Method == "GET" {
		if strings.HasPrefix(endpoint, "/draft/") {
			draft, err := s.billingDraft(q, q.Params["id"])
			if err != nil {
				return nil, err
			}
			return M{"id": draft["_id"], "path": draft["path"], "values": draft["values"]}, nil
		}
		if str(q.Session["billingCSRF"]) == "" {
			token, err := security.RandomToken()
			if err != nil {
				return nil, err
			}
			q.Session["billingCSRF"] = token
		}
		if err := q.saveSession(false); err != nil {
			return nil, err
		}
		account, err := s.Store.one(q.ctx(), "billingaccounts", M{"_id": q.Identity.ID})
		if err != nil {
			return nil, err
		}
		grants, err := s.Store.list(q.ctx(), "billinggrants", M{"owner": q.Identity.ID}, 0, nil)
		if err != nil {
			return nil, err
		}
		displayed, repoRows, purchases := []M{}, []M{}, []M{}
		var allowance any
		if s.Config.Billing.Enabled {
			for _, plan := range s.Config.Billing.Plans {
				if plan.PriceID == "" {
					continue
				}
				price, err := s.stripe(q.ctx(), "GET", "/prices/"+segment(plan.PriceID), nil, "")
				if err != nil {
					return nil, err
				}
				row := M{"id": plan.ID, "name": plan.Name, "description": plan.Description, "repositories": plan.Repositories, "storage": plan.Storage, "amount": price["unit_amount"], "currency": price["currency"]}
				if recurring := obj(price["recurring"]); len(recurring) > 0 {
					row["interval"], row["intervalCount"] = recurring["interval"], recurring["interval_count"]
				}
				displayed = append(displayed, row)
			}
			repos, err := s.Store.list(q.ctx(), collection("repo"), M{"owner": q.User["_id"], "status": M{"$ne": "removed"}}, 500, bson.D{{Key: "anonymizeDate", Value: -1}})
			if err != nil {
				return nil, err
			}
			for _, repo := range repos {
				row := selectFields(repo, "repoId", "status")
				for _, field := range []string{"expirationMode", "expirationDate"} {
					if value, exists := obj(repo["options"])[field]; exists {
						row[field] = value
					}
				}
				repoRows = append(repoRows, row)
			}
			allowance, err = s.billingAllowance(q.ctx(), q.Identity.ID, "", "")
			if err != nil {
				return nil, err
			}
			purchases = s.billingPurchases(q, grants)
		}
		publicGrants := []M{}
		for _, grant := range grants {
			row := selectFields(grant, "planId", "scope", "status", "until", "cancelAtPeriodEnd")
			if boolean(grant["revoked"]) {
				row["status"] = "revoked"
			}
			publicGrants = append(publicGrants, row)
		}
		return M{"enabled": s.Config.Billing.Enabled, "csrf": q.Session["billingCSRF"], "plans": displayed, "checkoutEnabled": s.Config.Billing.Checkout, "freeExpirationMonths": s.Config.Billing.FreeMonths, "grants": publicGrants, "purchases": purchases, "repositories": repoRows, "portal": str(account["customerId"]) != "", "allowance": allowance}, nil
	}
	csrf := str(q.Session["billingCSRF"])
	if csrf == "" || subtle.ConstantTimeCompare([]byte(csrf), []byte(q.R.Header.Get("X-CSRF-Token"))) != 1 {
		return nil, fail("invalid_auth_state", 403)
	}
	key := "go:billing-rate:" + q.Identity.ID + ":" + time.Now().UTC().Format("200601021504")
	count, err := s.Store.Redis.Incr(q.ctx(), key).Result()
	if err != nil {
		return nil, err
	}
	if count == 1 {
		s.Store.Redis.Expire(q.ctx(), key, 2*time.Minute)
	}
	if count > 30 {
		return nil, fail("rate_limited", 429)
	}
	if err = s.Config.Billing.require(); err != nil {
		return nil, err
	}
	switch endpoint {
	case "/draft":
		path, ok := q.Body["path"].(string)
		values := obj(q.Body["values"])
		raw, _ := json.Marshal(q.Body["values"])
		_, validValues := q.Body["values"].(map[string]any)
		if _, ok := q.Body["values"].(M); ok {
			validValues = true
		}
		if !ok || !billingDraftPath.MatchString(path) || !validValues || len(raw) > 64*1024 {
			return nil, fail("billing_invalid_draft", 400)
		}
		id := uuid.NewString()
		_, err := s.Store.DB.Collection("billingdrafts").InsertOne(q.ctx(), M{"_id": id, "owner": q.Identity.ID, "path": path, "values": selectFields(values, "sourceUrl", "terms", "repoId", "source", "options", "conference", "githubConnection"), "expiresAt": time.Now().Add(7 * 24 * time.Hour)})
		return M{"id": id}, err
	case "/checkout":
		plan, ok := q.Body["planId"].(string)
		if !ok {
			return nil, fail("invalid_request", 400)
		}
		target := ""
		if q.Body["target"] != nil {
			var valid bool
			target, valid = q.Body["target"].(string)
			if !valid {
				return nil, fail("invalid_request", 400)
			}
		}
		returnPath := ""
		if q.Body["draftId"] != nil {
			draft, err := s.billingDraft(q, str(q.Body["draftId"]))
			if err != nil {
				return nil, err
			}
			returnPath = str(draft["path"]) + "?billingDraft=" + str(draft["_id"])
		}
		address, err := s.createBillingCheckout(q.ctx(), q.Identity.ID, plan, target, returnPath)
		return M{"url": address}, err
	case "/portal":
		account, err := s.Store.one(q.ctx(), "billingaccounts", M{"_id": q.Identity.ID})
		if err != nil {
			return nil, err
		}
		if str(account["customerId"]) == "" {
			return nil, fail("billing_customer_not_found", 404)
		}
		portal, err := s.stripe(q.ctx(), "POST", "/billing_portal/sessions", M{"customer": account["customerId"], "return_url": strings.TrimSuffix(s.Config.Billing.Origin, "/") + "/profile?billing=portal"}, "")
		return M{"url": portal["url"]}, err
	case "/refresh":
		account, err := s.Store.one(q.ctx(), "billingaccounts", M{"_id": q.Identity.ID})
		if err != nil {
			return nil, err
		}
		checkout := obj(account["checkout"])
		pending := str(checkout["key"]) != "" && str(checkout["id"]) == ""
		if id := str(checkout["id"]); id != "" {
			if err = s.fulfillBillingCheckout(q.ctx(), id); err != nil {
				return nil, err
			}
			session, err := s.stripe(q.ctx(), "GET", "/checkout/sessions/"+segment(id), nil, "")
			if err != nil {
				return nil, err
			}
			pending = session["status"] != "expired" && session["payment_status"] == "unpaid"
		}
		grants, err := s.Store.list(q.ctx(), "billinggrants", M{"owner": q.Identity.ID, "subscriptionId": M{"$exists": true}}, 0, nil)
		if err != nil {
			return nil, err
		}
		for _, grant := range grants {
			if err = s.syncBillingSubscription(q.ctx(), str(grant["subscriptionId"])); err != nil {
				return nil, err
			}
		}
		return M{"ok": true, "pending": pending}, nil
	}
	return nil, fail("not_found", 404)
}
func (s *Server) billingPurchases(q *request, grants []M) []M {
	state := func(g M) string {
		if boolean(g["revoked"]) {
			if g["revocationReason"] == "dispute" {
				return "disputed"
			}
			return "refunded"
		}
		if g["status"] == "past_due" {
			return "overdue"
		}
		if usableBillingGrant(g, time.Now()) {
			return "active"
		}
		return "ended"
	}
	until := func(g M) any {
		value := date(g["until"])
		if value.IsZero() || !value.Before(billingNeverUntil) {
			return nil
		}
		return value
	}
	groups := map[string][]M{}
	keys := []string{}
	for _, grant := range grants {
		id := str(grant["_id"])
		key := id
		parts := strings.SplitN(id, ":", 2)
		if len(parts) == 2 && billingPackPart.MatchString(id) {
			count := 0
			for _, other := range grants {
				if strings.HasPrefix(str(other["_id"]), parts[0]+":") {
					count++
				}
			}
			if count == len(billingPack) {
				key = parts[0]
			}
		}
		if _, ok := groups[key]; !ok {
			keys = append(keys, key)
		}
		groups[key] = append(groups[key], grant)
	}
	out := []M{}
	for _, key := range keys {
		rows := groups[key]
		first := rows[0]
		pack := len(rows) > 1
		planID := str(first["planId"])
		if pack {
			planID = "repo_pack"
		}
		hash := sha256.Sum256([]byte(key))
		scope := strings.SplitN(str(first["scope"]), ":", 2)
		row := M{"id": hex.EncodeToString(hash[:])[:12], "planId": planID, "recurring": first["planId"] == "author_monthly" || first["planId"] == "author_annual", "repoId": nil, "conference": nil, "status": "ended", "until": until(first), "purchasedAt": first["purchasedAt"], "cancelAtPeriodEnd": boolean(first["cancelAtPeriodEnd"]), "amount": nil, "currency": nil, "interval": nil, "parts": []M{}}
		if len(scope) == 2 {
			if scope[0] == "repo" {
				row["repoId"] = scope[1]
			}
			if scope[0] == "conference" {
				row["conference"] = scope[1]
			}
		}
		priorities := map[string]int{"ended": 0, "active": 1, "overdue": 2, "refunded": 3, "disputed": 4}
		parts := []M{}
		for _, grant := range rows {
			status := state(grant)
			if priorities[status] > priorities[str(row["status"])] {
				row["status"] = status
			}
			if pack {
				parts = append(parts, M{"planId": grant["planId"], "until": until(grant), "status": status})
			}
		}
		if pack {
			row["until"] = nil
			row["parts"] = parts
		}
		if price := str(first["priceId"]); price != "" {
			value, err := s.stripe(q.ctx(), "GET", "/prices/"+segment(price), nil, "")
			if err == nil {
				row["amount"], row["currency"], row["interval"] = value["unit_amount"], value["currency"], obj(value["recurring"])["interval"]
			}
		}
		out = append(out, row)
	}
	sort.SliceStable(out, func(i, j int) bool {
		active := func(row M) bool { return row["status"] == "active" || row["status"] == "overdue" }
		if active(out[i]) != active(out[j]) {
			return active(out[i])
		}
		return date(out[i]["purchasedAt"]).After(date(out[j]["purchasedAt"]))
	})
	return out
}
