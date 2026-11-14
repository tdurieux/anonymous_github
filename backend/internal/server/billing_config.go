package server

import (
	_ "embed"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type BillingConfig struct {
	Enabled, Checkout, AutomaticTax bool
	Origin, Secret, WebhookSecret   string
	FreeMonths, FreeRepositories    int64
	FreeStorage                     int64
	Plans                           []BillingPlan
	LegacyPrices                    map[string]string
}
type BillingPlan struct {
	ID, Name, PriceID, Description string
	Recurring, Capacity            bool
	Repositories, Storage          int64
}

//go:embed billing_plans.json
var billingPlanDefinitions []byte
var billingNeverUntil = time.Date(9999, 12, 31, 0, 0, 0, 0, time.UTC)
var billingPack = []string{"repo_slot", "author_pass", "repo_extend"}

func conferencePlan(id string) bool {
	return id == "conference" || id == "conference_workshop" || id == "conference_large"
}
func (c BillingConfig) plan(id string) *BillingPlan {
	for _, p := range c.Plans {
		if p.ID == id {
			return &p
		}
	}
	return nil
}
func loadBillingConfig() (BillingConfig, error) {
	c := BillingConfig{Enabled: envBool("BILLING_ENABLED", false), Checkout: envBool("BILLING_CHECKOUT_ENABLED", true), AutomaticTax: envBool("BILLING_AUTOMATIC_TAX", false), Origin: env("BILLING_ORIGIN", "http://localhost:5000"), Secret: os.Getenv("STRIPE_SECRET_KEY"), WebhookSecret: os.Getenv("STRIPE_WEBHOOK_SECRET"), FreeMonths: int64(envInt("FREE_EXPIRATION_MONTHS", 5)), FreeRepositories: int64(envInt("FREE_AUTHOR_REPOSITORIES", 5)), FreeStorage: int64(envInt("FREE_AUTHOR_STORAGE", 2<<30)), LegacyPrices: map[string]string{}}
	defaults := map[string]int{"PAID_AUTHOR_REPOSITORIES": 20, "PAID_AUTHOR_STORAGE": 10 << 30, "PAID_PASS_STORAGE": 2 << 30, "PAID_CONFERENCE_REPOSITORIES": 100, "PAID_CONFERENCE_STORAGE": 50 << 30, "PAID_CONFERENCE_SMALL_REPOSITORIES": 25, "PAID_CONFERENCE_SMALL_STORAGE": 10 << 30, "PAID_CONFERENCE_LARGE_REPOSITORIES": 400, "PAID_CONFERENCE_LARGE_STORAGE": 200 << 30}
	if c.Enabled {
		for _, key := range append([]string{"FREE_EXPIRATION_MONTHS", "FREE_AUTHOR_REPOSITORIES", "FREE_AUTHOR_STORAGE"}, billingCapacityKeys(defaults)...) {
			if raw, ok := os.LookupEnv(key); ok {
				n, err := strconv.ParseInt(raw, 10, 64)
				if err != nil || n <= 0 || n > 9007199254740991 {
					return c, errors.New("invalid_" + key)
				}
			}
		}
	}
	var rows []M
	if err := json.Unmarshal(billingPlanDefinitions, &rows); err != nil {
		return c, err
	}
	for _, row := range rows {
		capacity := func(key string) int64 {
			if name, ok := row[key].(string); ok {
				return int64(envInt(name, defaults[name]))
			}
			return number(row[key])
		}
		c.Plans = append(c.Plans, BillingPlan{ID: str(row["id"]), Name: str(row["name"]), PriceID: os.Getenv(str(row["priceId"])), Description: str(row["description"]), Recurring: boolean(row["recurring"]), Capacity: boolean(row["capacity"]), Repositories: capacity("repositories"), Storage: capacity("storage")})
	}
	for _, entry := range strings.Split(os.Getenv("STRIPE_LEGACY_PRICES"), ",") {
		if strings.TrimSpace(entry) == "" {
			continue
		}
		p := strings.Split(entry, ":")
		if len(p) != 2 || c.plan(strings.TrimSpace(p[1])) == nil || !strings.HasPrefix(strings.TrimSpace(p[0]), "price_") {
			return c, errors.New("invalid_STRIPE_LEGACY_PRICES")
		}
		c.LegacyPrices[strings.TrimSpace(p[0])] = strings.TrimSpace(p[1])
	}
	if c.Enabled {
		if err := c.require(); err != nil {
			return c, err
		}
	}
	return c, nil
}
func (c BillingConfig) require() error {
	if !c.Enabled || c.Secret == "" || c.WebhookSecret == "" {
		return fail("billing_unavailable", 503)
	}
	u, err := url.Parse(c.Origin)
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) {
		return fail("billing_origin_invalid", 503)
	}
	return nil
}
func usableBillingGrant(g M, now time.Time) bool {
	return !boolean(g["revoked"]) && date(g["until"]).After(now) && (g["status"] == "active" || g["status"] == "past_due" || g["status"] == "paid")
}

func billingCapacityKeys(values map[string]int) []string {
	out := []string{}
	for key := range values {
		out = append(out, key)
	}
	return out
}
