package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func stripeSignature(body []byte, header, secret string, now time.Time) bool {
	timestamp := ""
	signatures := []string{}
	for _, part := range strings.Split(header, ",") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		if kv[0] == "t" {
			timestamp = kv[1]
		}
		if kv[0] == "v1" {
			signatures = append(signatures, kv[1])
		}
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || secret == "" || seconds < now.Add(-5*time.Minute).Unix() || seconds > now.Add(5*time.Minute).Unix() {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "."))
	mac.Write(body)
	expected := mac.Sum(nil)
	for _, signature := range signatures {
		decoded, err := hex.DecodeString(signature)
		if err == nil && hmac.Equal(decoded, expected) {
			return true
		}
	}
	return false
}
func (s *Server) billingWebhook(q *request) (any, error) {
	if !s.Config.Billing.Enabled {
		return nil, fail("not_found", 404)
	}
	if q.R.Method != "POST" {
		return nil, fail("not_found", 404)
	}
	raw, err := io.ReadAll(http.MaxBytesReader(q.W, q.R.Body, 256*1024))
	if err != nil || !stripeSignature(raw, q.R.Header.Get("Stripe-Signature"), s.Config.Billing.WebhookSecret, time.Now()) {
		return nil, fail("invalid_billing_signature", 400)
	}
	var event M
	if json.Unmarshal(raw, &event) != nil || str(event["id"]) == "" {
		return nil, fail("invalid_billing_signature", 400)
	}
	live := strings.HasPrefix(s.Config.Billing.Secret, "sk_live_") || strings.HasPrefix(s.Config.Billing.Secret, "rk_live_")
	if str(event["account"]) != "" {
		return nil, fail("billing_environment_mismatch", 400)
	}
	if flag, ok := event["livemode"].(bool); ok && flag != live {
		return nil, fail("billing_environment_mismatch", 400)
	}
	value := obj(obj(event["data"])["object"])
	sanitized := selectFields(value, "id", "amount", "amount_refunded", "refunded", "disputed")
	sanitized["payment_intent"], sanitized["charge"] = stripeRef(value["payment_intent"]), stripeRef(value["charge"])
	sanitized["parent"] = M{"subscription_details": M{"subscription": stripeRef(obj(obj(value["parent"])["subscription_details"])["subscription"])}}
	namespace := "test"
	if boolean(event["livemode"]) {
		namespace = "live"
	}
	err = s.billingUpsert(q.ctx(), "billingevents", M{"_id": namespace + ":platform:" + str(event["id"])}, M{"$setOnInsert": M{"eventId": event["id"], "type": event["type"], "object": sanitized, "state": "pending", "attempts": 0, "receivedAt": time.Now(), "nextAttemptAt": time.Now()}})
	if err != nil {
		return nil, fail("billing_webhook_failed", 500)
	}
	return M{"received": true}, nil
}
func (s *Server) processBillingEvent(ctx context.Context, event M) error {
	kind := str(event["type"])
	value := obj(event["object"])
	if kind == "checkout.session.completed" || kind == "checkout.session.async_payment_succeeded" {
		return s.fulfillBillingCheckout(ctx, str(value["id"]))
	}
	if strings.HasPrefix(kind, "customer.subscription.") {
		return s.syncBillingSubscription(ctx, str(value["id"]))
	}
	if kind == "invoice.paid" || kind == "invoice.payment_failed" {
		id := stripeRef(obj(obj(value["parent"])["subscription_details"])["subscription"])
		if id != "" {
			return s.syncBillingSubscription(ctx, id)
		}
		return nil
	}
	if kind != "charge.refunded" && kind != "charge.dispute.created" {
		return nil
	}
	charge := value
	if kind == "charge.dispute.created" {
		var err error
		charge, err = s.stripe(ctx, "GET", "/charges/"+segment(stripeRef(value["charge"])), nil, "")
		if err != nil {
			return err
		}
	}
	if kind == "charge.refunded" && charge["refunded"] == false {
		return nil
	}
	intent := stripeRef(charge["payment_intent"])
	if intent == "" {
		return nil
	}
	reason := "full_refund"
	if kind == "charge.dispute.created" || boolean(charge["disputed"]) {
		reason = "dispute"
	}
	if err := s.billingUpsert(ctx, "billingrevocations", M{"_id": intent}, M{"$setOnInsert": M{"reason": reason, "reviewed": false, "createdAt": time.Now()}}); err != nil {
		return err
	}
	if reason == "dispute" {
		if _, err := s.Store.update(ctx, "billingrevocations", M{"_id": intent, "reason": "full_refund"}, M{"$set": M{"reason": reason, "reviewed": false}}); err != nil {
			return err
		}
	}
	reversal, err := s.Store.one(ctx, "billingrevocations", M{"_id": intent})
	if err != nil {
		return err
	}
	if boolean(reversal["reviewed"]) {
		return nil
	}
	revoked := M{"revoked": true, "revocationReason": reason, "revokedAt": time.Now()}
	if _, err = s.Store.DB.Collection("billinggrants").UpdateMany(ctx, M{"paymentIntentId": intent}, M{"$set": revoked, "$inc": M{"revision": 1}}); err != nil {
		return err
	}
	return s.stripeEach(ctx, "/invoice_payments", M{"payment": M{"type": "payment_intent", "payment_intent": intent}}, func(payment M) error {
		invoice, err := s.stripe(ctx, "GET", "/invoices/"+segment(stripeRef(payment["invoice"])), nil, "")
		if err != nil {
			return err
		}
		subscription := stripeRef(obj(obj(invoice["parent"])["subscription_details"])["subscription"])
		if subscription == "" {
			return nil
		}
		if _, err = s.Store.update(ctx, "billingrevocations", M{"_id": intent}, M{"$set": M{"subscriptionId": subscription}}); err != nil {
			return err
		}
		return s.billingUpsert(ctx, "billinggrants", M{"_id": subscription}, M{"$set": revoked, "$inc": M{"revision": 1}})
	})
}
func (s *Server) processBillingInbox(ctx context.Context) error {
	namespace := "^test:platform:"
	if strings.HasPrefix(s.Config.Billing.Secret, "sk_live_") || strings.HasPrefix(s.Config.Billing.Secret, "rk_live_") {
		namespace = "^live:platform:"
	}
	for i := 0; i < 25; i++ {
		now, token := time.Now(), uuid.NewString()
		var event M
		err := s.Store.DB.Collection("billingevents").FindOneAndUpdate(ctx, M{"_id": M{"$regex": namespace}, "$or": []M{{"state": "pending", "nextAttemptAt": M{"$lte": now}}, {"state": "processing", "leaseUntil": M{"$lte": now}}}}, M{"$set": M{"state": "processing", "token": token, "leaseUntil": now.Add(5 * time.Minute)}, "$inc": M{"attempts": 1}}, options.FindOneAndUpdate().SetSort(bson.D{{Key: "receivedAt", Value: 1}}).SetReturnDocument(options.After)).Decode(&event)
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil
		}
		if err != nil {
			return err
		}
		work, cancel := context.WithTimeout(ctx, 4*time.Minute)
		failure := s.processBillingEvent(work, event)
		cancel()
		update := M{"$set": M{"state": "complete", "completedAt": time.Now()}, "$unset": M{"token": 1, "leaseUntil": 1, "lastError": 1}}
		if failure != nil {
			state := "pending"
			attempts := number(event["attempts"])
			if attempts >= 12 {
				state = "failed"
			}
			delay := min(time.Hour, time.Second*time.Duration(1<<min(attempts, 20)))
			update = M{"$set": M{"state": state, "lastError": "billing_processing_failed", "nextAttemptAt": time.Now().Add(delay)}, "$unset": M{"token": 1, "leaseUntil": 1}}
		}
		if _, err = s.Store.update(ctx, "billingevents", M{"_id": event["_id"], "token": token}, update); err != nil {
			return err
		}
	}
	return nil
}
