package server

import (
	"context"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var githubNextLink = regexp.MustCompile(`<([^<>]+)>;[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*rel="next"`)

// githubPages keeps pagination inside the GitHub adapter. The visitor can stop
// after an identity match; callers collecting a list publish it only on success.
// Cancellation and the per-response byte bound still apply on every page.
func (s *Server) githubPages(ctx context.Context, endpoint, token, field string, visit func(M) bool) error {
	u, err := url.Parse(endpoint)
	if err != nil {
		return err
	}
	query := u.Query()
	query.Set("per_page", "100")
	query.Set("page", "1")
	u.RawQuery = query.Encode()
	for page := 1; ; page++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if field != "" {
			query.Set("page", strconv.Itoa(page))
			u.RawQuery = query.Encode()
		}
		raw, headers, err := s.githubResponse(ctx, "GET", u.String(), token, nil, field == "")
		if err != nil {
			return err
		}
		if field != "" {
			raw = obj(raw)[field]
		}
		rows := arr(raw)
		for _, row := range rows {
			if err := ctx.Err(); err != nil {
				return err
			}
			if visit(obj(row)) {
				return nil
			}
		}
		if field != "" {
			if len(rows) < 100 {
				return nil
			}
			continue
		}
		next := githubNextLink.FindStringSubmatch(strings.Join(headers.Values("Link"), ", "))
		if len(next) == 0 {
			return nil
		}
		// Follow GitHub's cursor verbatim, but never its authority. This
		// preserves cursor pagination without exposing bearer credentials.
		target, err := url.Parse(next[1])
		if err != nil || target.Scheme != "https" || target.Host != "api.github.com" || target.User != nil || target.Fragment != "" || strings.HasPrefix(target.Path, "//") || strings.ContainsAny(target.Path, "\\\r\n") {
			return fail("invalid_github_url", 502)
		}
		u, err = url.Parse(target.RequestURI())
		if err != nil {
			return fail("invalid_github_url", 502)
		}
	}
}
