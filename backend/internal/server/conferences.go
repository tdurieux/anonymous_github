package server

import (
	"go.mongodb.org/mongo-driver/v2/bson"
	"math"
	"strings"
	"time"
)

var plans = []M{
	{"id": "free_conference", "name": "Free", "pricePerRepo": 0, "storagePerRepo": -1, "description": "<li><strong>Quota is deducted from user account</strong></li>\n    <li>No-download</li>\n    <li>Conference dashboard</li>"},
	{"id": "premium_conference", "name": "Premium", "pricePerRepo": 0.5, "storagePerRepo": 500 * 8 * 1024, "description": "<li>500Mo / repository</li>\n    <li>Repository download</li>\n    <li>Conference dashboard</li>"},
	{"id": "unlimited_conference", "name": "Unlimited", "pricePerRepo": 3, "storagePerRepo": 0, "description": "<li><strong>Unlimited</strong> repository size</li>\n    <li>Repository download</li>\n    <li>Conference dashboard</li>"},
}

func conferenceOwner(q *request, c M) bool {
	if q.Identity.Admin {
		return true
	}
	for _, v := range arr(c["owners"]) {
		if str(v) == q.Identity.ID {
			return true
		}
	}
	return false
}
func conferenceJSON(c M) M {
	return conferenceJSONAt(c, time.Now())
}
func conferenceJSONAt(c M, now time.Time) M {
	out := selectFields(c, "conferenceID", "name", "url", "startDate", "endDate", "status", "options", "plan", "billing")
	today := now
	if end := date(c["endDate"]); c["endDate"] != nil && end.Before(today) {
		today = end
	}
	price := float64(0)
	plan := obj(c["plan"])
	rate := decimal(plan["pricePerRepository"]) / 30
	if _, present := plan["pricePerRepository"]; !present {
		rate = math.NaN()
	}
	active := 0
	for _, value := range arr(c["repositories"]) {
		r := obj(value)
		end := today
		if removed := date(r["removeDate"]); inputTruthy(r["removeDate"]) && removed.Before(end) {
			end = removed
		}
		if !inputTruthy(r["removeDate"]) {
			active++
		}
		start := date(r["addDate"])
		// Follow JavaScript's millisecond arithmetic and operation order. A Go
		// duration saturates at about 292 years and changes fractional rounding.
		days := math.Max(float64(end.UnixMilli())-float64(start.UnixMilli()), 0) / 1000 / 60 / 60 / 24
		charge := float64(days * rate)
		price += charge
	}
	out["price"] = price
	if math.IsNaN(price) || math.IsInf(price, 0) {
		out["price"] = nil
	}
	out["nbRepositories"] = active
	return out
}
func (s *Server) conferences(q *request) (any, error) {
	id := q.Params["id"]
	if id == "" && q.R.Method == "GET" {
		rows, err := s.Store.list(q.ctx(), "conferences", M{"owners": q.User["_id"]}, 0, nil)
		if err != nil {
			return nil, err
		}
		pending, err := s.pendingConferences(q.ctx(), rows)
		if err != nil {
			return nil, err
		}
		out := []M{}
		for _, c := range rows {
			if pending[str(c["conferenceID"])] {
				var err error
				c, err = s.reconcileConference(q.ctx(), c)
				if err != nil {
					return nil, err
				}
			}
			if err := s.expireConference(q.ctx(), c); err != nil {
				return nil, err
			}
			out = append(out, conferenceJSON(c))
		}
		return out, nil
	}
	var c M
	var err error
	if id != "" {
		c, err = s.Store.one(q.ctx(), "conferences", M{"conferenceID": id})
		if err != nil {
			return nil, err
		}
		if c == nil {
			if q.R.Method == "POST" {
				return nil, fail("conference_not_found", 404)
			}
			if q.R.Method == "DELETE" {
				return nil, fail("conf_not_found", 400)
			}
			return nil, fail("conf_not_found", 404)
		}
	}
	if q.R.Method == "GET" {
		if !conferenceOwner(q, c) {
			return selectFields(c, "conferenceID", "name", "url", "startDate", "endDate", "options"), nil
		}
		c, err = s.reconcileConference(q.ctx(), c)
		if err != nil {
			return nil, err
		}
		out := conferenceJSON(c)
		rows, err := s.Store.list(q.ctx(), "anonymizedrepositories", M{"_id": M{"$in": conferenceRepositoryIDs(c)}}, 0, nil)
		if err != nil {
			return nil, err
		}
		repos := []M{}
		for _, r := range rows {
			repos = append(repos, resourceJSON("repo", r))
		}
		out["repositories"] = repos
		return out, nil
	}
	if c != nil && !conferenceOwner(q, c) {
		return nil, fail("not_authorized", 401)
	}
	if q.R.Method == "DELETE" {
		c, err = s.reconcileConference(q.ctx(), c)
		if err != nil {
			return nil, err
		}
		if err := s.removeConference(q.ctx(), c); err != nil {
			return nil, err
		}
		return q.text("ok"), nil
	}
	body := q.Body
	plan, err := validateConferenceForm(body, time.Now())
	if err != nil {
		return nil, err
	}
	start, end, err := conferenceFormDates(body)
	if err != nil {
		return nil, err
	}
	newID := str(body["conferenceID"])
	if c == nil && !resourceID.MatchString(newID) {
		return nil, fail("invalid_conference_id", 400)
	}
	set := selectFields(body, "name", "url")
	set["startDate"] = start
	set["endDate"] = end
	set["status"] = "ready"
	options, err := conferenceOptions(body)
	if err != nil {
		return nil, err
	}
	for key, value := range options {
		set[key] = value
	}
	if c == nil {
		planID := str(obj(body["plan"])["planID"])
		set["_id"] = bson.NewObjectID()
		set["conferenceID"] = newID
		set["owners"] = []any{q.User["_id"]}
		set["repositories"] = []any{}
		set["status"] = "ready"
		set["dateOfEntry"] = time.Now()
		set["plan"] = M{"planID": planID, "pricePerRepository": plan["pricePerRepo"], "quota": M{"size": plan["storagePerRepo"], "file": 0, "repository": 0}}
		if body["billing"] != nil {
			set["billing"] = selectFields(obj(body["billing"]), "name", "email", "address", "address2", "city", "zip", "country", "vat")
		}
		if _, err = s.Store.DB.Collection("conferences").InsertOne(q.ctx(), set); err != nil {
			return nil, fail("conf_id_used", 400)
		}
	} else {
		update := M{"$set": set}
		if _, present := options["options"]; !present {
			update["$unset"] = M{"options": ""}
		}
		if _, err = s.Store.update(q.ctx(), "conferences", M{"_id": c["_id"]}, update); err != nil {
			return nil, err
		}
	}
	return q.text("ok"), nil
}
func (s *Server) validateConference(q *request, id string) error {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	c, err := s.Store.one(q.ctx(), "conferences", M{"conferenceID": id})
	if err != nil {
		return err
	}
	if c == nil {
		return fail("conf_not_found", 404)
	}
	now := time.Now()
	if str(c["status"]) != "ready" || date(c["startDate"]).After(now) || date(c["endDate"]).Before(now) {
		return fail("conf_not_activated", 400)
	}
	return nil
}

// Keep validation order aligned with the TypeScript form for both creates and
// edits. The selected plan is validated on edits but is only saved on creation.
func validateConferenceForm(body M, now time.Time) (M, error) {
	for _, field := range []struct{ name, code string }{
		{"name", "conf_name_missing"},
		{"conferenceID", "conf_id_missing"},
		{"startDate", "conf_start_date_missing"},
		{"endDate", "conf_end_date_missing"},
	} {
		if !inputTruthy(body[field.name]) {
			return nil, fail(field.code, 400)
		}
	}
	start, startOK, err := javascriptDateValue(body["startDate"])
	if err != nil {
		return nil, err
	}
	end, endOK, err := javascriptDateValue(body["endDate"])
	if err != nil {
		return nil, err
	}
	if startOK && endOK && start.After(end) {
		return nil, fail("conf_start_date_invalid", 400)
	}
	if endOK && now.After(end) {
		return nil, fail("conf_end_date_invalid", 400)
	}
	var plan M
	for _, candidate := range plans {
		if str(candidate["id"]) == str(obj(body["plan"])["planID"]) {
			plan = candidate
			break
		}
	}
	if plan == nil {
		return nil, fail("invalid_plan", 400)
	}
	if decimal(plan["pricePerRepo"]) > 0 {
		if !inputTruthy(body["billing"]) {
			return nil, fail("billing_missing", 400)
		}
		billing := obj(body["billing"])
		for _, field := range []string{"name", "email", "address", "city", "zip", "country"} {
			if !inputTruthy(billing[field]) {
				return nil, fail("billing_"+field+"_missing", 400)
			}
		}
	}
	return plan, nil
}
