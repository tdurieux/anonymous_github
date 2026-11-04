package provider

import (
	"errors"
	"time"
)

// Adapters can wrap these errors with internal context. The server publishes
// only the stable category, never a remote response body or wrapper message.
var (
	ErrNotFound     = errors.New("resource_not_found")
	ErrAccessDenied = errors.New("not_authorized")
	ErrRateLimited  = errors.New("rate_limited")
	ErrUpstream     = errors.New("upstream_error")
)

// RateLimitError carries an optional reset instant without depending on HTTP
// handlers, MongoDB, or a particular provider's rate-limit headers.
type RateLimitError struct{ ResetAt time.Time }

func (e *RateLimitError) Error() string { return ErrRateLimited.Error() }
func (e *RateLimitError) Unwrap() error { return ErrRateLimited }
