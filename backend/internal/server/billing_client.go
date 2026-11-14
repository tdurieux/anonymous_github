package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func stripeRef(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	return str(obj(value)["id"])
}
func stripeValues(values M) url.Values {
	out := url.Values{}
	var add func(string, any)
	add = func(key string, value any) {
		switch v := value.(type) {
		case M:
			for k, x := range v {
				add(key+"["+k+"]", x)
			}
		case map[string]any:
			for k, x := range v {
				add(key+"["+k+"]", x)
			}
		case bson.D:
			for _, field := range v {
				add(key+"["+field.Key+"]", field.Value)
			}
		case bson.A:
			for i, x := range v {
				add(key+"["+strconv.Itoa(i)+"]", x)
			}
		case []any:
			for i, x := range v {
				add(key+"["+strconv.Itoa(i)+"]", x)
			}
		case []M:
			for i, x := range v {
				add(key+"["+strconv.Itoa(i)+"]", x)
			}
		case []string:
			for i, x := range v {
				add(key+"["+strconv.Itoa(i)+"]", x)
			}
		case nil:
			out.Set(key, "")
		default:
			out.Set(key, fmt.Sprint(v))
		}
	}
	for key, value := range values {
		add(key, value)
	}
	return out
}
func (s *Server) stripe(ctx context.Context, method, path string, params M, idempotency string) (M, error) {
	if err := s.Config.Billing.require(); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "?#\\") {
		return nil, fail("billing_invalid_request", 500)
	}
	encoded := stripeValues(params).Encode()
	address := "https://api.stripe.com/v1" + path
	var body io.Reader
	if method == "GET" {
		if encoded != "" {
			address += "?" + encoded
		}
	} else {
		body = strings.NewReader(encoded)
	}
	work, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(work, method, address, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+s.Config.Billing.Secret)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Stripe-Version", "2026-10-28.endive")
	if idempotency != "" {
		request.Header.Set("Idempotency-Key", idempotency)
	}
	client := *s.HTTP
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return nil, fail("billing_provider_unavailable", 502)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024+1))
	if err != nil || len(raw) > 4*1024*1024 {
		return nil, fail("billing_provider_unavailable", 502)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fail("billing_provider_failed", 502)
	}
	var result M
	if json.Unmarshal(raw, &result) != nil {
		return nil, fail("billing_provider_invalid_response", 502)
	}
	return result, nil
}
func (s *Server) stripeEach(ctx context.Context, path string, params M, visit func(M) error) error {
	if params == nil {
		params = M{}
	}
	copied := M{}
	for k, v := range params {
		copied[k] = v
	}
	params = copied
	params["limit"] = 100
	seen := map[string]bool{}
	for page := 0; page < 10000; page++ {
		response, err := s.stripe(ctx, "GET", path, params, "")
		if err != nil {
			return err
		}
		rows := arr(response["data"])
		for _, row := range rows {
			if err := visit(obj(row)); err != nil {
				return err
			}
		}
		if !boolean(response["has_more"]) {
			return nil
		}
		if len(rows) == 0 {
			return fail("billing_provider_invalid_response", 502)
		}
		after := str(obj(rows[len(rows)-1])["id"])
		if after == "" || seen[after] {
			return fail("billing_provider_invalid_response", 502)
		}
		seen[after] = true
		params["starting_after"] = after
	}
	return fail("billing_provider_page_limit", 502)
}
func (s *Server) billingUpsert(ctx context.Context, collection string, filter, update M) error {
	_, err := s.Store.DB.Collection(collection).UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true))
	return err
}
func (s *Server) billingLock(ctx context.Context, id string, work func(context.Context) error) error {
	token := uuid.NewString()
	now := time.Now()
	if err := s.billingUpsert(ctx, "billinglocks", M{"_id": id, "until": M{"$lt": now}}, M{"$set": M{"token": token, "until": now.Add(3 * time.Minute)}}); err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return fail("billing_busy", 409)
		}
		return err
	}
	lockCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-lockCtx.Done():
				return
			case <-ticker.C:
				result, err := s.Store.DB.Collection("billinglocks").UpdateOne(lockCtx, M{"_id": id, "token": token}, M{"$set": M{"until": time.Now().Add(3 * time.Minute)}})
				if err != nil || result.MatchedCount != 1 {
					cancel()
					return
				}
			}
		}
	}()
	defer func() {
		cancel()
		<-done
		cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		s.Store.DB.Collection("billinglocks").DeleteOne(cleanup, M{"_id": id, "token": token})
	}()
	return work(lockCtx)
}
func (s *Server) billingPlanForPrice(ctx context.Context, id string, recurring bool) (*BillingPlan, error) {
	if id == "" {
		return nil, nil
	}
	for _, plan := range s.Config.Billing.Plans {
		if plan.Recurring == recurring && plan.PriceID == id {
			return &plan, nil
		}
	}
	planID := s.Config.Billing.LegacyPrices[id]
	if planID == "" {
		row, err := s.Store.one(ctx, "billingprices", M{"_id": id})
		if err != nil {
			return nil, err
		}
		planID = str(row["planId"])
	}
	plan := s.Config.Billing.plan(planID)
	if plan == nil || plan.Recurring != recurring {
		return nil, nil
	}
	return plan, nil
}
func (s *Server) rememberBillingPrices(ctx context.Context) error {
	for _, p := range s.Config.Billing.Plans {
		if p.PriceID != "" {
			if err := s.billingUpsert(ctx, "billingprices", M{"_id": p.PriceID}, M{"$setOnInsert": M{"planId": p.ID}}); err != nil {
				return err
			}
		}
	}
	for price, plan := range s.Config.Billing.LegacyPrices {
		if err := s.billingUpsert(ctx, "billingprices", M{"_id": price}, M{"$setOnInsert": M{"planId": plan}}); err != nil {
			return err
		}
	}
	return nil
}

var errBillingStop = errors.New("billing_stop_iteration")
