package server

import (
	"encoding/json"
	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func runBillingIntegration(t *testing.T, base *Server) {
	ctx := t.Context()
	db := base.Store.DB.Client().Database("billing_test_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	config := base.Config
	config.Billing = BillingConfig{Enabled: true, Checkout: true, Origin: "https://anonymous.test", Secret: "sk_test_synthetic", WebhookSecret: "whsec_synthetic", FreeMonths: 5, FreeRepositories: 2, FreeStorage: 100, Plans: []BillingPlan{{ID: "repo_slot", PriceID: "price_slot", Capacity: true, Repositories: 1, Storage: 200}, {ID: "repo_extend", PriceID: "price_extend"}, {ID: "author_pass", PriceID: "price_pass", Capacity: true, Repositories: 1, Storage: 200}, {ID: "repo_pack", PriceID: "price_pack"}}}
	s := &Server{Config: config, Store: &Store{DB: db, Redis: base.Store.Redis}}
	owner := bson.NewObjectID()
	user := M{"_id": owner, "username": "billing-fixture", "status": "active"}
	_, err := db.Collection("users").InsertOne(ctx, user)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Collection("billingaccounts").InsertOne(ctx, M{"_id": owner.Hex(), "customerId": "cus_fixture"})
	if err != nil {
		t.Fatal(err)
	}
	refund := false
	s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.stripe.com" {
			t.Fatalf("unexpected host %s", r.URL.Host)
		}
		var result M
		switch r.URL.Path {
		case "/v1/checkout/sessions/cs_fixture":
			result = M{"id": "cs_fixture", "customer": "cus_fixture", "status": "complete", "payment_status": "paid", "created": time.Now().Unix(), "metadata": M{"application": "anonymous-github", "owner": owner.Hex(), "planId": "repo_pack", "target": "billing-repo"}, "line_items": M{"data": []M{{"quantity": 1, "price": M{"id": "price_pack"}}}}, "payment_intent": M{"id": "pi_fixture", "latest_charge": M{"refunded": refund, "disputed": false}}}
		case "/v1/prices/price_pack":
			result = M{"id": "price_pack", "unit_amount": 900, "currency": "eur"}
		case "/v1/invoice_payments":
			result = M{"data": []any{}, "has_more": false}
		default:
			t.Fatalf("unexpected Stripe path %s", r.URL.Path)
		}
		raw, _ := json.Marshal(result)
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(raw)))}, nil
	})}
	if err = s.fulfillBillingCheckout(ctx, "cs_fixture"); err != nil {
		t.Fatal(err)
	}
	if err = s.fulfillBillingCheckout(ctx, "cs_fixture"); err != nil {
		t.Fatal(err)
	}
	grants, err := s.Store.list(ctx, "billinggrants", M{}, 0, nil)
	if err != nil || len(grants) != 3 {
		t.Fatal("pack not fulfilled exactly once", len(grants), err)
	}
	for _, g := range grants {
		if !usableBillingGrant(g, time.Now()) {
			t.Fatal("unusable paid grant", g)
		}
	}
	q := &request{R: httptest.NewRequest("GET", "/api/admin/billing/summary?period=30d", nil), W: httptest.NewRecorder(), Server: s}
	report, err := s.billingSummaryReport(q)
	if err != nil {
		t.Fatal(err)
	}
	if number(obj(obj(report)["sales"])["count"]) != 1 || decimal(obj(obj(obj(report)["sales"])["revenue"])["eur"]) != 900 {
		t.Fatal("pack sales duplicated", report)
	}
	q.R = httptest.NewRequest("GET", "/api/admin/billing/grants?search=billing-fixture&state=active", nil)
	listed, err := s.billingGrantReport(q)
	if err != nil || number(obj(listed)["total"]) != 3 {
		t.Fatal("grant search failed", listed, err)
	}
	if err = s.reserveBillingRepository(ctx, owner.Hex(), "free-one", 60, "", "", 0); err != nil {
		t.Fatal(err)
	}
	if err = s.reserveBillingRepository(ctx, owner.Hex(), "free-one", 60, "", "", 0); err != nil {
		t.Fatal("reservation not idempotent", err)
	}
	if err = s.reserveBillingRepository(ctx, owner.Hex(), "free-two", 50, "", "", 0); err == nil {
		t.Fatal("storage quota bypassed")
	}
	if err = s.reserveBillingRepository(ctx, owner.Hex(), "billing-repo", 150, "", "", 0); err != nil {
		t.Fatal("paid capacity unavailable", err)
	}
	if err = s.processBillingEvent(ctx, M{"type": "charge.refunded", "object": M{"id": "ch_fixture", "payment_intent": "pi_fixture", "amount": 900, "amount_refunded": 900, "refunded": true}}); err != nil {
		t.Fatal(err)
	}
	if err = s.fulfillBillingCheckout(ctx, "cs_fixture"); err != nil {
		t.Fatal(err)
	}
	grants, err = s.Store.list(ctx, "billinggrants", M{}, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range grants {
		if !boolean(g["revoked"]) {
			t.Fatal("checkout replay restored refunded access", g)
		}
	}
}

func runOwnerAlertsIntegration(t *testing.T, base *Server) {
	ctx := t.Context()
	db := base.Store.DB.Client().Database("alerts_test_" + bson.NewObjectID().Hex())
	defer db.Drop(ctx)
	s := &Server{Store: &Store{DB: db, Redis: base.Store.Redis}, Config: Config{EmailAPIKey: "synthetic", EmailFrom: "alerts@example.test", Hostname: "anonymous.test"}}
	sends := 0
	s.HTTP = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.resend.com" {
			t.Fatal(r.URL.Host)
		}
		sends++
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{}`))}, nil
	})}
	resources := []M{}
	for i := 0; i < 2; i++ {
		owner := bson.NewObjectID()
		_, err := db.Collection("users").InsertOne(ctx, M{"_id": owner, "status": "active", "notificationEmail": "shared@example.test"})
		if err != nil {
			t.Fatal(err)
		}
		row := M{"_id": bson.NewObjectID(), "repoId": owner.Hex(), "owner": owner, "status": "ready"}
		_, err = db.Collection(collection("repo")).InsertOne(ctx, row)
		if err != nil {
			t.Fatal(err)
		}
		resources = append(resources, row)
	}
	if err := s.notifyOwnerAccessProblem(ctx, "repo", resources[0], fail("repo_not_found", 502)); err != nil {
		t.Fatal(err)
	}
	if sends != 0 {
		t.Fatal("outage sent an access alert")
	}
	for _, r := range resources {
		if err := s.notifyOwnerAccessProblem(ctx, "repo", r, fail("repo_not_found", 404)); err != nil {
			t.Fatal(err)
		}
	}
	if sends != 1 {
		t.Fatal("recipient was notified more than once", sends)
	}
	if err := s.resetOwnerAlerts(ctx, resources[0]["owner"], "repo", resources[0]["_id"]); err != nil {
		t.Fatal(err)
	}
	if err := s.notifyOwnerAccessProblem(ctx, "repo", resources[0], fail("repo_not_found", 404)); err != nil {
		t.Fatal(err)
	}
	if sends != 1 {
		t.Fatal("reset erased delivery history")
	}
	_, err := db.Collection("users").UpdateOne(ctx, M{"_id": resources[1]["owner"]}, M{"$set": M{"notificationEmail": "new@example.test"}})
	if err != nil {
		t.Fatal(err)
	}
	finish, err := s.beginAlertDeactivation(ctx, resources[1]["owner"])
	if err != nil {
		t.Fatal(err)
	}
	if err = s.notifyOwnerAccessProblem(ctx, "repo", resources[1], fail("repo_not_found", 404)); err != nil {
		t.Fatal(err)
	}
	finish()
	if sends != 1 {
		t.Fatal("deactivation allowed dispatch")
	}
	if err = s.notifyOwnerAccessProblem(ctx, "repo", resources[1], fail("repo_not_found", 404)); err != nil {
		t.Fatal(err)
	}
	if sends != 2 {
		t.Fatal("new recipient not notified")
	}

	for _, state := range []string{"prepared", "committed"} {
		attempt := uuid.NewString()
		email := state + "@example.test"
		owner := resources[1]["owner"]
		_, err := db.Collection("users").UpdateOne(ctx, M{"_id": owner}, M{"$set": M{"notificationEmail": email, "accessAlertDispatches." + attempt: M{"state": state}}})
		if err != nil {
			t.Fatal(err)
		}
		_, err = db.Collection(recipientAlerts).InsertOne(ctx, M{"_id": alertRecipientKey(email), "owner": owner, "resourceKind": "repository", "resourceId": resources[1]["_id"], "attemptId": attempt, "state": "sending", "dispatchPrepared": true, "claimedAt": time.Now().Add(-2 * time.Minute)})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.notifyOwnerAccessProblem(ctx, "repo", resources[1], fail("repo_not_found", 404)); err != nil {
			t.Fatal(err)
		}
		if sends != 3 {
			t.Fatalf("%s recovery: sends=%d", state, sends)
		}
	}
}
