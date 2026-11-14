package server

import (
	"math"
	"time"
)

func billingBucket(d time.Time, unit string) time.Time {
	d = d.UTC()
	day := d.Day()
	if unit == "month" {
		day = 1
	}
	out := time.Date(d.Year(), d.Month(), day, 0, 0, 0, 0, time.UTC)
	if unit == "week" {
		out = out.AddDate(0, 0, -(int(out.Weekday())+6)%7)
	}
	return out
}
func billingNextBucket(d time.Time, unit string) time.Time {
	if unit == "month" {
		return d.AddDate(0, 1, 0)
	}
	if unit == "week" {
		return d.AddDate(0, 0, 7)
	}
	return d.AddDate(0, 0, 1)
}

type billingTotals struct {
	count, missing int64
	money          map[string]float64
}

func (t *billingTotals) add(price M, monthly bool, plan string) {
	t.count++
	if price == nil || price["unit_amount"] == nil {
		t.missing++
		return
	}
	if t.money == nil {
		t.money = map[string]float64{}
	}
	amount := decimal(price["unit_amount"])
	if monthly {
		recurring := obj(price["recurring"])
		interval := str(recurring["interval"])
		if interval == "" {
			interval = "month"
			if plan == "author_annual" {
				interval = "year"
			}
		}
		factor := map[string]float64{"day": 365.0 / 12, "week": 52.0 / 12, "month": 1, "year": 1.0 / 12}[interval]
		if factor == 0 {
			factor = 1
		}
		amount = amount * factor / math.Max(1, decimal(recurring["interval_count"]))
	}
	t.money[str(price["currency"])] += amount
}
func (t billingTotals) amounts() M {
	out := M{}
	for c, n := range t.money {
		out[c] = math.Floor(n + 0.5)
	}
	return out
}
func (t billingTotals) json(available bool) M {
	return M{"count": t.count, "revenue": t.amounts(), "complete": available && t.missing == 0}
}

type billingPlanTotals struct {
	all, period billingTotals
	active      int64
}

func (s *Server) billingSummaryReport(q *request) (any, error) {
	q.W.Header().Set("Cache-Control", "no-store")
	period := q.R.URL.Query().Get("period")
	days, ok := map[string]int{"7d": 7, "30d": 30, "90d": 90, "12m": 365, "all": 0}[period]
	if !ok {
		period, days = "30d", 30
	}
	now := time.Now()
	var since time.Time
	var sinceJSON any
	if days > 0 {
		since = now.Add(-time.Duration(days) * 24 * time.Hour)
		sinceJSON = since
	}
	unit := "day"
	if period == "12m" {
		unit = "week"
	}
	if period == "all" {
		unit = "month"
	}
	pack := M{"$regexMatch": M{"input": M{"$toString": "$_id"}, "regex": billingPackPart.String()}}
	subscription := M{"$ne": []any{M{"$ifNull": []any{"$subscriptionId", nil}}, nil}}
	cond := func(test, a, b any) M { return M{"$cond": []any{test, a, b}} }
	fallback := func(value, defaultValue any) M { return M{"$ifNull": []any{value, defaultValue}} }
	project := M{"sale": cond(pack, M{"$arrayElemAt": []any{M{"$split": []any{"$_id", ":"}}, 0}}, "$_id"), "plan": cond(pack, "repo_pack", cond(subscription, fallback("$salePlanId", "subscription_unknown"), fallback("$planId", "unknown"))), "priceId": cond(subscription, fallback("$salePriceId", nil), "$priceId"), "currentPriceId": "$priceId", "currentPlan": cond(pack, "repo_pack", fallback("$planId", "unknown")), "purchasedAt": cond(M{"$and": []any{subscription, M{"$not": []any{M{"$gt": []any{"$until", time.Unix(0, 0)}}}}}}, nil, "$purchasedAt"), "cancel": M{"$eq": []any{"$cancelAtPeriodEnd", true}}, "usable": M{"$and": []any{M{"$ne": []any{"$revoked", true}}, M{"$gt": []any{"$until", now}}, M{"$in": []any{"$status", []string{"active", "paid", "past_due"}}}}}}
	group := M{"_id": "$sale", "plan": M{"$first": "$plan"}, "priceId": M{"$first": "$priceId"}, "currentPlan": M{"$first": "$currentPlan"}, "currentPriceId": M{"$first": "$currentPriceId"}, "purchasedAt": M{"$min": "$purchasedAt"}, "active": M{"$max": "$usable"}, "cancel": M{"$max": "$cancel"}}
	cursor, err := s.Store.DB.Collection("billinggrants").Aggregate(q.ctx(), []M{{"$project": project}, {"$group": group}})
	if err != nil {
		return nil, err
	}
	defer cursor.Close(q.ctx())
	available := s.Config.Billing.Enabled && s.Config.Billing.Secret != ""
	prices := map[string]M{}
	price := func(id string) M {
		if !available || id == "" {
			return nil
		}
		if p, ok := prices[id]; ok {
			return p
		}
		p, err := s.stripe(q.ctx(), "GET", "/prices/"+segment(id), nil, "")
		if err != nil {
			p = nil
		}
		prices[id] = p
		return p
	}
	all, selected, subs := billingTotals{}, billingTotals{}, billingTotals{}
	monthly, annual, cancelling := int64(0), int64(0), int64(0)
	plans := map[string]*billingPlanTotals{}
	order := []string{}
	names := map[string]string{}
	for _, p := range s.Config.Billing.Plans {
		order = append(order, p.ID)
		names[p.ID] = p.Name
		plans[p.ID] = &billingPlanTotals{}
	}
	ensure := func(id string) *billingPlanTotals {
		if p := plans[id]; p != nil {
			return p
		}
		p := &billingPlanTotals{}
		plans[id] = p
		order = append(order, id)
		return p
	}
	series := map[time.Time]M{}
	first := since
	for cursor.Next(q.ctx()) {
		var row M
		if err = cursor.Decode(&row); err != nil {
			return nil, err
		}
		plan, current := str(row["plan"]), str(row["currentPlan"])
		p := ensure(plan)
		at := date(row["purchasedAt"])
		if !at.IsZero() {
			rate := price(str(row["priceId"]))
			all.add(rate, false, plan)
			p.all.add(rate, false, plan)
			if since.IsZero() || !at.Before(since) {
				selected.add(rate, false, plan)
				p.period.add(rate, false, plan)
				bucket := billingBucket(at, unit)
				if first.IsZero() || bucket.Before(first) {
					first = bucket
				}
				v := series[bucket]
				if v == nil {
					v = M{"date": bucket, "subscription": int64(0), "repository": int64(0), "conference": int64(0)}
					series[bucket] = v
				}
				family := billingFamily(plan)
				v[family] = number(v[family]) + 1
			}
		}
		if boolean(row["active"]) {
			ensure(current).active++
			if current == "author_monthly" || current == "author_annual" {
				subs.add(price(str(row["currentPriceId"])), true, current)
				if current == "author_monthly" {
					monthly++
				} else {
					annual++
				}
				if boolean(row["cancel"]) {
					cancelling++
				}
			}
		}
	}
	if err = cursor.Err(); err != nil {
		return nil, err
	}
	timeline := []M{}
	if !first.IsZero() {
		for d := billingBucket(first, unit); !d.After(now); d = billingNextBucket(d, unit) {
			row := series[d]
			if row == nil {
				row = M{"date": d, "subscription": 0, "repository": 0, "conference": 0}
			}
			timeline = append(timeline, row)
		}
	}
	planRows := []M{}
	for _, id := range order {
		p := plans[id]
		name := names[id]
		if name == "" {
			name = id
		}
		planRows = append(planRows, M{"planId": id, "name": name, "family": billingFamily(id), "active": p.active, "sales": p.period.count, "revenue": p.period.amounts(), "revenueComplete": available && p.period.missing == 0, "allTimeSales": p.all.count, "allTimeRevenue": p.all.amounts(), "allTimeRevenueComplete": available && p.all.missing == 0})
	}
	reversalPipeline := []M{}
	if !since.IsZero() {
		reversalPipeline = append(reversalPipeline, M{"$match": M{"createdAt": M{"$gte": since}}})
	}
	for _, spec := range []struct{ as, local, foreign string }{{"checkout", "_id", "paymentIntentId"}, {"subscription", "subscriptionId", "_id"}} {
		reversalPipeline = append(reversalPipeline, M{"$lookup": M{"from": "billinggrants", "localField": spec.local, "foreignField": spec.foreign, "pipeline": []M{{"$match": M{"owner": M{"$type": "string"}}}, {"$limit": 1}}, "as": spec.as}})
	}
	reversalPipeline = append(reversalPipeline, M{"$match": M{"$or": []M{{"checkout.0": M{"$exists": true}}, {"subscription.0": M{"$exists": true}}}}}, M{"$group": M{"_id": "$reason", "count": M{"$sum": 1}}})
	reversals := M{"refunds": int64(0), "disputes": int64(0)}
	rc, err := s.Store.DB.Collection("billingrevocations").Aggregate(q.ctx(), reversalPipeline)
	if err != nil {
		return nil, err
	}
	var rs []M
	if err = rc.All(q.ctx(), &rs); err != nil {
		return nil, err
	}
	for _, r := range rs {
		if r["_id"] == "full_refund" {
			reversals["refunds"] = r["count"]
		}
		if r["_id"] == "dispute" {
			reversals["disputes"] = r["count"]
		}
	}
	health, err := s.billingWebhookHealth(q)
	if err != nil {
		return nil, err
	}
	var reason any
	missingSales, missingAll, missingSubs := selected.missing, all.missing, subs.missing
	if !available {
		reason = "stripe_not_configured"
		missingSales, missingAll, missingSubs = 0, 0, 0
	}
	return M{"period": period, "since": sinceJSON, "now": now, "bucket": unit, "sales": selected.json(available), "allTime": all.json(available), "subscriptions": M{"active": subs.count, "monthly": monthly, "annual": annual, "cancelling": cancelling, "mrr": subs.amounts(), "complete": available && subs.missing == 0}, "reversals": reversals, "plans": planRows, "series": timeline, "revenue": M{"available": available, "reason": reason, "missingSales": missingSales, "missingAllTimeSales": missingAll, "missingSubscriptions": missingSubs, "basis": "list_price"}, "webhooks": health}, nil
}
