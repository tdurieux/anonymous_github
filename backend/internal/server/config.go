package server

import (
	"errors"
	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"math"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ReviewKeys                                                                                 *string
	Billing                                                                                    BillingConfig
	EmailAPIKey, EmailFrom                                                                     string
	GitHubPermissionTTL                                                                        time.Duration
	SharedCacheDecisions                                                                       bool
	SharedResultBytes                                                                          int64
	SharedCacheEnabled                                                                         bool
	SharedCache                                                                                blobcache.Options
	Storage, S3Bucket, S3Region, S3Endpoint, S3ID, S3Secret                                    string
	Address, MongoURI, Database, RedisAddress, SessionSecret, Root, PublicDir, Hostname, Mask  string
	ClientID, ClientSecret, Callback                                                           string
	AppID, AppClientID, AppClientSecret, AppCallback, AppSlug, AppPrivateKey, AppWebhookSecret string
	AppEnabled, AppNewConnections, OAuthEnabled, Download, SecureCookies                       bool
	CacheMonitoring                                                                            bool
	TrustedHops                                                                                int
	RateLimit, Workers                                                                         int
	Cipher                                                                                     *security.Cipher
	TrustedProxies                                                                             []*net.IPNet
}

func env(key, fallback string) string {
	if s, ok := os.LookupEnv(key); ok {
		return s
	}
	return fallback
}
func envBool(key string, fallback bool) bool {
	s, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	return s == "true" || s == "1"
}
func envInt(key string, fallback int) int {
	v, err := strconv.Atoi(os.Getenv(key))
	if err != nil || v <= 0 {
		return fallback
	}
	return v
}
func LoadConfig() (Config, error) {
	c := Config{EmailAPIKey: os.Getenv("RESEND_API_KEY"), EmailFrom: os.Getenv("EMAIL_FROM"), CacheMonitoring: envBool("CACHE_MONITORING_ENABLED", true), Storage: env("STORAGE", "filesystem"), S3Bucket: os.Getenv("S3_BUCKET"), S3Region: os.Getenv("S3_REGION"), S3Endpoint: os.Getenv("S3_ENDPOINT"), S3ID: os.Getenv("S3_CLIENT_ID"), S3Secret: os.Getenv("S3_CLIENT_SECRET"), Address: ":" + env("PORT", "5000"), MongoURI: os.Getenv("MONGODB_URI"), Database: env("MONGODB_DATABASE", "production"), RedisAddress: net.JoinHostPort(env("REDIS_HOSTNAME", "redis"), env("REDIS_PORT", "6379")), SessionSecret: os.Getenv("SESSION_SECRET"), Root: env("FOLDER", "repositories"), PublicDir: env("PUBLIC_DIR", "public"), Hostname: env("APP_HOSTNAME", "localhost:5000"), Mask: env("ANONYMIZATION_MASK", "XXXX"), ClientID: os.Getenv("CLIENT_ID"), ClientSecret: os.Getenv("CLIENT_SECRET"), Callback: env("AUTH_CALLBACK", "http://localhost:5000/github/auth"), AppID: os.Getenv("GITHUB_APP_ID"), AppClientID: os.Getenv("GITHUB_APP_CLIENT_ID"), AppClientSecret: os.Getenv("GITHUB_APP_CLIENT_SECRET"), AppCallback: env("GITHUB_APP_CALLBACK", "http://localhost:5000/github/app/callback"), AppSlug: os.Getenv("GITHUB_APP_SLUG"), AppPrivateKey: os.Getenv("GITHUB_APP_PRIVATE_KEY"), AppWebhookSecret: os.Getenv("GITHUB_APP_WEBHOOK_SECRET"), AppEnabled: envBool("GITHUB_APP_ENABLED", false), AppNewConnections: envBool("GITHUB_APP_NEW_CONNECTIONS", true), OAuthEnabled: envBool("GITHUB_OAUTH_ENABLED", true), Download: envBool("ENABLE_DOWNLOAD", true), SecureCookies: envBool("COOKIE_SECURE", os.Getenv("NODE_ENV") == "production"), RateLimit: envInt("RATE_LIMIT", 1000), Workers: envInt("ANONYMIZATION_WORKERS", 1)}
	if raw, ok := os.LookupEnv("REVIEW_SERVICE_KEYS"); ok {
		c.ReviewKeys = &raw
	}
	if _, err := parseReviewRegistry(c.ReviewKeys); err != nil {
		return c, err
	}
	var billingErr error
	c.Billing, billingErr = loadBillingConfig()
	if billingErr != nil {
		return c, billingErr
	}
	if raw, ok := os.LookupEnv("GITHUB_PERMISSION_CACHE_SECONDS"); ok {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds < 0 || seconds > 3600 {
			return c, errors.New("invalid_GITHUB_PERMISSION_CACHE_SECONDS")
		}
		c.GitHubPermissionTTL = time.Duration(seconds) * time.Second
	}
	c.SharedCacheEnabled = envBool("SHARED_CACHE_ENABLED", false)
	c.SharedCacheDecisions = envBool("SHARED_CACHE_DECISIONS", true)
	c.SharedResultBytes = 512 * 1024 * 1024
	saving, low := 0.1, 0.9
	for key, value := range map[string]*float64{"SHARED_CACHE_GZIP_MIN_SAVING": &saving, "SHARED_CACHE_LOW_WATER": &low} {
		if raw, ok := os.LookupEnv(key); ok {
			parsed, err := strconv.ParseFloat(raw, 64)
			if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 || parsed > 1 {
				return c, errors.New("invalid_" + key)
			}
			*value = parsed
		}
	}
	c.SharedCache = blobcache.Options{Root: env("SHARED_CACHE_PATH", filepath.Join(c.Root, ".shared-cache-v1")), Budget: 10 * 1024 * 1024 * 1024, MaxObject: 32 * 1024 * 1024, Gzip: envBool("SHARED_CACHE_GZIP", true), Saving: &saving, LowWater: &low, FreeBytes: 1024 * 1024 * 1024}
	for key, dest := range map[string]*int64{"SHARED_CACHE_RESULT_BYTES": &c.SharedResultBytes, "SHARED_CACHE_BYTES": &c.SharedCache.Budget, "SHARED_CACHE_MAX_FILE_BYTES": &c.SharedCache.MaxObject} {
		if raw, ok := os.LookupEnv(key); ok {
			value, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || value <= 0 {
				return c, errors.New("invalid_" + key)
			}
			*dest = value
		}
	}
	if raw, ok := os.LookupEnv("SHARED_CACHE_FREE_BYTES"); ok {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value < 0 {
			return c, errors.New("invalid_SHARED_CACHE_FREE_BYTES")
		}
		c.SharedCache.FreeBytes = value
	}
	if c.SessionSecret == "" {
		return c, errors.New("SESSION_SECRET is required")
	}
	if c.MongoURI == "" {
		c.MongoURI = "mongodb://" + url.UserPassword(os.Getenv("DB_USERNAME"), os.Getenv("DB_PASSWORD")).String() + "@" + net.JoinHostPort(env("DB_HOSTNAME", "mongodb"), "27017") + "/production?authSource=admin"
	} else {
		u, e := url.Parse(c.MongoURI)
		if e != nil {
			return c, errors.New("invalid_mongodb_uri")
		}
		if u.Path != "" && u.Path != "/" {
			c.Database = strings.TrimPrefix(u.Path, "/")
		}
	}
	var err error
	c.Cipher, err = security.NewCipher(os.Getenv("CREDENTIAL_KEYS"), os.Getenv("CREDENTIAL_ACTIVE_KEY_ID"))
	if err != nil {
		return c, err
	}
	if err = configureProxy(&c, os.Getenv("TRUST_PROXY")); err != nil {
		return c, err
	}

	if file := os.Getenv("GITHUB_APP_PRIVATE_KEY_FILE"); file != "" {
		b, e := os.ReadFile(file)
		if e != nil {
			return c, errors.New("cannot_read_app_private_key")
		}
		c.AppPrivateKey = string(b)
	}
	return c, nil
}
