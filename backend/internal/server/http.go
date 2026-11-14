package server

import (
	"context"
	"encoding/json"
	"errors"
	"golang.org/x/sync/singleflight"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"github.com/tdurieux/anonymous_github/backend/internal/quotagate"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"github.com/tdurieux/anonymous_github/backend/internal/storage"
)

type APIError struct {
	Code    string
	Status  int
	ResetAt int64
}

func (e *APIError) Error() string        { return e.Code }
func fail(code string, status int) error { return &APIError{Code: code, Status: status} }

type handler func(*request) (any, error)
type route struct {
	method   string
	template string
	pattern  *regexp.Regexp
	names    []string
	auth     string
	handler  handler
}
type Server struct {
	ownerAlertSlots        chan struct{}
	review                 *reviewRegistry
	webFiles               webFileCache
	permissions            permissionCache
	publicStats            publicStatsState
	jobWorkerCounts        [3]atomic.Int64
	queueHistory           queueMetricHistory
	errorLog               errorLogBufferState
	resultCache            *blobcache.Cache
	sourceCache            *blobcache.Cache
	sharedCacheCancel      context.CancelFunc
	sharedCacheDone        chan struct{}
	providers              *provider.Registry
	quotaOnce              sync.Once
	quotaMu                sync.Mutex
	providerQuota          *quotagate.Gate
	quotaScopes            map[string]string
	Config                 Config
	Store                  *Store
	HTTP                   *http.Client
	routes                 []route
	public                 *os.Root
	requests               atomic.Uint64
	failures               atomic.Uint64
	removalRecoveryPending atomic.Bool
	started                time.Time
	pool                   *anonymize.Pool
	content                *storage.Store
	transfers              chan struct{}
	pathBuilds             chan struct{}
	tokenMu                sync.Mutex
	appTokens              map[string]installationToken
	tokenFlights           singleflight.Group
	cacheFills             atomic.Int64
	cacheMetrics           *cacheMetrics
	requestMetrics         *requestMetrics
	dashboardNames         dashboardCache
}
type request struct {
	W           http.ResponseWriter
	R           *http.Request
	Params      map[string]string
	Body        M
	User        M
	Identity    security.Identity
	Session     M
	SessionID   string
	Maintenance bool
	Server      *Server
}

func (q *request) ctx() context.Context { return q.R.Context() }
func (q *request) text(s string) any {
	q.W.Header().Set("Content-Type", "text/plain; charset=utf-8")
	q.W.Header().Set("Content-Length", strconv.Itoa(len(s)))
	q.W.Write([]byte(s))
	return written{}
}
func (q *request) redirect(s string) any {
	redirectKnownLength(q.W, q.R, s, http.StatusFound)
	return written{}
}

type written struct{}

func New(c Config, store *Store, extensions ...provider.Provider) (*Server, error) {
	review, err := parseReviewRegistry(c.ReviewKeys)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(c.PublicDir)
	if err != nil {
		return nil, errors.New("public_directory_unavailable")
	}
	s := &Server{ownerAlertSlots: make(chan struct{}, 16), review: review, Config: c, Store: store, public: root, started: time.Now(), HTTP: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too_many_redirects")
		}
		if req.URL.Scheme != "https" {
			return errors.New("unsafe_redirect")
		}
		if len(via) > 0 && req.URL.Host != via[0].URL.Host {
			req.Header.Del("Authorization")
		}
		return nil
	}}}
	initCtx, initCancel := context.WithTimeout(context.Background(), 2*time.Minute)
	initErr := s.initializeOwnerAlerts(initCtx)
	initCancel()
	if initErr != nil {
		root.Close()
		return nil, initErr
	}
	binary, err := os.Executable()
	if err != nil {
		root.Close()
		return nil, err
	}
	s.pool = anonymize.NewPool(binary, c.Workers)
	s.content, err = storage.New(storage.Config{Kind: c.Storage, Root: c.Root, Bucket: c.S3Bucket, Region: c.S3Region, Endpoint: c.S3Endpoint, ID: c.S3ID, Secret: c.S3Secret})
	if err != nil {
		root.Close()
		return nil, err
	}
	s.transfers = make(chan struct{}, 8)
	s.pathBuilds = make(chan struct{}, 2)
	s.providers, err = provider.New(append([]provider.Provider{&githubProvider{s}, &archiveProvider{s}}, extensions...)...)
	if err != nil {
		s.Close()
		return nil, err
	}
	s.register()
	s.startCacheMetrics()
	s.startRequestMetrics()
	if err = s.startSharedCache(); err != nil {
		s.Close()
		return nil, err
	}
	return s, nil
}
func (s *Server) Close() {
	s.closeStatsCache()
	if s.requestMetrics != nil {
		close(s.requestMetrics.stop)
		<-s.requestMetrics.done
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		s.flushRequestMetrics(ctx)
		s.removeProcessSample(ctx)
		cancel()
	}
	if s.sharedCacheCancel != nil {
		s.sharedCacheCancel()
		<-s.sharedCacheDone
	}
	if s.sourceCache != nil {
		s.sourceCache.Close()
	}
	if s.resultCache != nil {
		s.resultCache.Close()
	}
	if s.cacheMetrics != nil {
		close(s.cacheMetrics.stop)
		<-s.cacheMetrics.done
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		s.flushCacheMetrics(ctx)
		cancel()
	}
	if s.pool != nil {
		s.pool.Close()
	}
	s.public.Close()
	s.content.Close()
}
func (s *Server) add(method, pattern, auth string, h handler) {
	parts := strings.Split(strings.Trim(pattern, "/"), "/")
	names := []string{}
	out := []string{}
	for _, p := range parts {
		if strings.HasPrefix(p, ":") {
			names = append(names, p[1:])
			out = append(out, "([^/]+)")
		} else if strings.HasPrefix(p, "*") {
			names = append(names, p[1:])
			out = append(out, "(.+)")
		} else {
			out = append(out, regexp.QuoteMeta(p))
		}
	}
	s.routes = append(s.routes, route{method, pattern, regexp.MustCompile("^/" + strings.Join(out, "/") + "/?$"), names, auth, h})
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	state := &responseState{ResponseWriter: w}
	w = state
	ctx, cancel := context.WithTimeout(r.Context(), requestTimeout(r))
	defer cancel()
	trace := newRequestTrace()
	w.Header().Set("X-Request-ID", trace.id)
	ctx = context.WithValue(ctx, performanceContextKey{}, trace)
	r = r.WithContext(context.WithValue(ctx, cacheTrafficKey{}, cacheTraffic(r)))
	done := s.monitorRequest(state, r)
	defer func() {
		value := recover()
		if value != nil {
			state.writeFailed = true
		}
		done()
		if value != nil {
			panic(value)
		}
	}()
	// Express mounts the webhook before response compression.
	if r.URL.Path != "/github/app/webhook" {
		compressed := &compressionWriter{ResponseWriter: w, request: r}
		w = compressed
		defer func() {
			if value := recover(); value != nil {
				panic(value)
			}
			if err := compressed.finish(); err != nil {
				panic(http.ErrAbortHandler)
			}
		}()
	}

	s.requests.Add(1)
	rawPath := strings.ToLower(r.URL.EscapedPath())
	if (strings.Contains(r.URL.Path, "/file/") || strings.HasPrefix(r.URL.Path, "/w/")) && (strings.Contains(rawPath, "%2f") || strings.Contains(rawPath, "%5c")) {
		writeError(w, fail("invalid_path", 400))
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	defer func() {
		if value := recover(); value != nil {
			if value == http.ErrAbortHandler {
				panic(value)
			}
			s.failures.Add(1)
			slog.Error("request panicked", "requestId", trace.id, "route", s.performanceRoute(r))
			writeError(w, fail("server_error", 500))
		}
	}()
	if r.URL.Path == "/service" || strings.HasPrefix(r.URL.Path, "/service/") {
		s.reviewCapabilities(w, r)
		return
	}
	if reviewConsentPath(r.URL.Path) {
		s.reviewConsentPage(w, r)
		return
	}
	if strings.TrimSuffix(r.URL.Path, "/") == "/api/billing/webhook" {
		result, err := s.billingWebhook(&request{W: w, R: r, Server: s})
		if err != nil {
			writeError(w, err)
		} else {
			writeJSON(w, result)
		}
		return
	}
	if r.URL.Path == "/github/app/webhook" {
		s.webhook(w, r)
		return
	}
	if r.URL.Path == "/healthcheck" || r.URL.Path == "/api/healthcheck" {
		writeJSON(w, M{"status": "ok"})
		return
	}
	q := &request{W: w, R: r, Params: map[string]string{}, Body: M{}, Session: M{}, Server: s}
	if r.Header.Get("Authorization") != "" {
		n, e := s.incrementLimit(q.ctx(), "go:token-attempt:"+s.clientIP(r).String(), 60000)
		if e != nil {
			writeError(w, fail("rate_limit_unavailable", 503))
			return
		}
		if n > 120 {
			writeError(w, fail("token_attempts_rate_limited", 429))
			return
		}
	}
	if err := s.authenticate(q); err != nil {
		writeError(w, err)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/github/") || strings.HasPrefix(r.URL.Path, "/w/") {
		if err := s.rateLimit(q); err != nil {
			writeError(w, err)
			return
		}
	}
	for _, route := range s.routes {
		if route.method != r.Method && !(r.Method == "HEAD" && route.method == "GET") {
			continue
		}
		m := route.pattern.FindStringSubmatch(r.URL.Path)
		if m == nil {
			continue
		}
		if route.auth != "" && !q.Identity.Active() {
			writeError(w, fail("not_connected", 401))
			return
		}
		if route.auth == "admin" && !q.Identity.Admin {
			writeError(w, fail("not_authorized", 401))
			return
		}
		for i, name := range route.names {
			q.Params[name] = m[i+1]
		}
		if r.Body != nil && r.ContentLength != 0 && (r.Method == "POST" || r.Method == "PUT" || r.Method == "PATCH" || r.Method == "DELETE") {
			if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				limit := int64(100 * 1024)
				if r.URL.Path == "/api/anonymize-preview" {
					limit = 3 * 1024 * 1024
				}
				d := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
				if err := d.Decode(&q.Body); err != nil {
					writeError(w, fail("invalid_request", 400))
					return
				}
				var extra any
				if d.Decode(&extra) != io.EOF {
					writeError(w, fail("invalid_request", 400))
					return
				}
				if q.Body == nil {
					q.Body = M{}
				}
			}
		}
		var release func()
		if strings.Contains(r.URL.Path, "/file/") || strings.HasSuffix(r.URL.Path, "/zip") || strings.HasPrefix(r.URL.Path, "/w/") {
			select {
			case s.transfers <- struct{}{}:
				release = func() { <-s.transfers }
			default:
				writeError(w, fail("server_busy", 503))
				return
			}
			defer release()
		}
		result, err := route.handler(q)
		if err != nil {
			s.failures.Add(1)
			s.recordError(q.ctx(), err)
			writeError(w, err)
			return
		}
		if _, ok := result.(written); ok {
			return
		}
		writeJSON(w, result)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api") || strings.HasPrefix(r.URL.Path, "/github") {
		writeError(w, fail("not_found", 404))
		return
	}
	s.static(w, r)
}
func writeJSON(w http.ResponseWriter, value any) { writeJSONStatus(w, value, 200) }
func writeJSONStatus(w http.ResponseWriter, value any, status int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	output := &jsonEntityWriter{writer: w, status: status}
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(responseJSON(value)); err != nil {
		if output.started {
			panic(http.ErrAbortHandler)
		}
		writeError(w, fail("internal_error", 500))
	}
}
func writeError(w http.ResponseWriter, err error) {
	// Once headers are sent, a second response would corrupt the stream and
	// conceal a truncated download. Match Express's connection-abort behavior.
	if responseCommitted(w) {
		panic(http.ErrAbortHandler)
	}
	for _, name := range []string{"Content-Length", "Content-Encoding", "Content-Disposition", "Content-Range", "ETag", "Last-Modified", "Transfer-Encoding", "Trailer"} {
		w.Header().Del(name)
	}
	var api *APIError
	if !errors.As(providerFailure(err), &api) {
		api = &APIError{Code: "internal_error", Status: 500}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	body := M{"error": api.Code}
	if api.Code == "rate_limited" && api.ResetAt > 0 {
		body["resetAt"] = api.ResetAt
	}
	output := &jsonEntityWriter{writer: w, status: api.Status}
	if err := json.NewEncoder(output).Encode(body); err != nil {
		panic(http.ErrAbortHandler)
	}
}
func (s *Server) clientIP(r *http.Request) netip.Addr {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip, _ := netip.ParseAddr(host)
	trusted := func(ip netip.Addr) bool {
		for _, n := range s.Config.TrustedProxies {
			if n.Contains(net.IP(ip.AsSlice())) {
				return true
			}
		}
		return false
	}
	if trusted(ip) || s.Config.TrustedHops > 0 {
		parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		for i := len(parts) - 1; i >= 0; i-- {
			if s.Config.TrustedHops > 0 && len(parts)-i > s.Config.TrustedHops {
				break
			}
			next, err := netip.ParseAddr(strings.TrimSpace(parts[i]))
			if err != nil {
				break
			}
			ip = next
			if s.Config.TrustedHops == 0 && !trusted(ip) {
				break
			}
		}
	}
	if cloudflareIP(ip) {
		if visitor, e := netip.ParseAddr(strings.TrimSpace(r.Header.Get("CF-Connecting-IP"))); e == nil {
			ip = visitor
		}
	}
	return ip.Unmap()
}
func (s *Server) rateLimit(q *request) error {
	if q.Identity.Active() && q.Identity.Admin && !q.Maintenance {
		return nil
	}
	ip := s.clientIP(q.R)
	key := ip.String()
	if ip.Is6() {
		key = netip.PrefixFrom(ip, 56).Masked().String()
	}
	if q.Maintenance {
		key = "maintenance:" + q.Identity.ID
		if q.R.Method == "POST" && strings.HasSuffix(strings.TrimSuffix(q.R.URL.Path, "/"), "/refresh") {
			parts := strings.Split(q.R.URL.Path, "/")
			if len(parts) > 3 {
				n, e := s.incrementLimit(q.ctx(), "go:maintenance-refresh:"+q.Identity.ID+":"+strings.ToLower(parts[3]), 60000)
				if e != nil {
					return fail("rate_limit_unavailable", 503)
				}
				if n > 1 {
					return fail("refresh_rate_limited", 429)
				}
			}
		}
	}
	limit := s.Config.RateLimit
	if !q.Identity.Active() {
		limit /= 2
	}
	if limit < 1 {
		limit = 1
	}
	n, err := s.Store.Redis.Eval(q.ctx(), `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end;return n`, []string{"go:rate:" + key}, 900000).Int64()
	if err != nil {
		return fail("rate_limit_unavailable", 503)
	}
	q.W.Header().Set("RateLimit-Limit", strconv.Itoa(limit))
	q.W.Header().Set("RateLimit-Remaining", strconv.FormatInt(max(0, int64(limit)-n), 10))
	if n > int64(limit) {
		q.W.Header().Set("Retry-After", "900")
		return fail("rate_limit_exceeded", 429)
	}
	return nil
}

var hashedAsset = regexp.MustCompile(`^(script|css)/([^/]+)\.[a-f0-9]{10}\.(min\.\w+|\w+)$`)

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		writeError(w, fail("not_found", 404))
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p != "" {
		if clean, err := security.RelativePath(p); err == nil {
			safe := true
			for _, part := range strings.Split(clean, "/") {
				if strings.HasPrefix(part, ".") {
					safe = false
				}
			}
			if safe {
				name := clean
				if m := hashedAsset.FindStringSubmatch(clean); m != nil {
					name = m[1] + "/" + m[2] + "." + m[3]
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				if name != "index.html" {
					if file, err := s.public.Open(name); err == nil {
						defer file.Close()
						if info, e := file.Stat(); e == nil && !info.IsDir() {
							if w.Header().Get("Cache-Control") == "" {
								w.Header().Set("Cache-Control", "public, max-age=86400")
							}
							http.ServeContent(w, r, info.Name(), info.ModTime(), file)
							return
						}
					}
				}
			}
		}
	}
	for _, prefix := range []string{"script", "css", "favicon", "api"} {
		if strings.HasPrefix(p, prefix) {
			writeError(w, fail("not_found", 404))
			return
		}
	}
	if strings.HasPrefix(p, "r/") && r.Header.Get("Accept") != "" && !strings.Contains(r.Header.Get("Accept"), "text/html") {
		parts := strings.SplitN(p, "/", 3)
		if len(parts) == 3 {
			redirectKnownLength(w, r, "/api/repo/"+url.PathEscape(parts[1])+"/file/"+parts[2], 302)
			return
		}
	}
	data, err := s.public.ReadFile("index.html")
	if err != nil {
		writeError(w, fail("not_found", 404))
		return
	}
	manifest := map[string]string{}
	if b, e := s.public.ReadFile("asset-manifest.json"); e == nil {
		json.Unmarshal(b, &manifest)
	}
	html := string(data)
	for token, name := range map[string]string{"__CORE_JS__": "core.min.js", "__VENDOR_JS__": "vendor.min.js", "__MERMAID_JS__": "mermaid.min.js", "__ALL_CSS__": "all.min.css"} {
		value := manifest[name]
		if value == "" {
			value = name
		}
		html = strings.Replace(html, token, value, 1)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(html)))
	if r.Method != http.MethodHead {
		w.Write([]byte(html))
	}
}

func (s *Server) incrementLimit(ctx context.Context, key string, ms int64) (int64, error) {
	return s.Store.Redis.Eval(ctx, `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end;return n`, []string{key}, ms).Int64()
}
