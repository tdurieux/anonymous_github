// Package logging emits only collector-approved diagnostics. Messages, errors,
// URLs and arbitrary attributes are never serialized, even in development.
package logging

import (
	"context"
	_ "embed"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"regexp"
	"slices"
	"strings"

	"github.com/google/uuid"
)

//go:embed policy.json
var policyJSON []byte

var policy struct {
	Events  map[string]string   `json:"events"`
	Allowed map[string][]string `json:"allowed"`
	Numbers []string            `json:"numbers"`
}
var traceID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var releaseID = regexp.MustCompile(`^[a-f0-9]{7,40}$`)

func init() {
	if err := json.Unmarshal(policyJSON, &policy); err != nil {
		panic(err)
	}
}

type Handler struct {
	output            slog.Handler
	attrs             []slog.Attr
	grouped           bool
	instance, release string
}

func New(w io.Writer, level slog.Leveler, release string) *Handler {
	if !releaseID.MatchString(release) {
		release = "unknown"
	}
	output := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level, ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
		switch a.Key {
		case slog.TimeKey:
			a.Key = "timestamp"
		case slog.LevelKey:
			return slog.String("severity", strings.ToLower(a.Value.String()))
		case slog.MessageKey:
			a.Key = "message"
		}
		return a
	}})
	return &Handler{output: output, instance: uuid.NewString(), release: release}
}
func (h *Handler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.output.Enabled(ctx, level)
}
func (h *Handler) WithAttrs(attrs []slog.Attr) slog.Handler {
	copy := *h
	if !h.grouped {
		copy.attrs = append(slices.Clone(h.attrs), attrs...)
	}
	return &copy
}
func (h *Handler) WithGroup(name string) slog.Handler {
	copy := *h
	if name != "" {
		copy.grouped = true
	}
	return &copy
}
func (h *Handler) Handle(ctx context.Context, r slog.Record) error {
	event := policy.Events[r.Message]
	if event == "" {
		event = "application_log"
	}
	out := slog.NewRecord(r.Time, r.Level, event, 0)
	fields := map[string]slog.Value{}
	add := func(a slog.Attr) {
		// Do not Resolve LogValuers or format errors/Stringers: those may expose
		// arbitrary provider data or execute user-defined code.
		if a.Value.Kind() == slog.KindString {
			key, value := a.Key, a.Value.String()
			switch key {
			case "code", "error":
				key = "errorCode"
			case "hostname":
				key = "upstreamHost"
				if !slices.Contains([]string{"github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com", "media.githubusercontent.com"}, value) {
					value = "other"
				}
				fields[key] = slog.StringValue(value)
				return
			case "requestId", "jobId", "deliveryId":
				if traceID.MatchString(value) {
					fields[key] = slog.StringValue(value)
				}
				return
			case "stage", "module", "route", "method", "queue", "outcome", "reason", "phase", "webhookEvent", "errorCode":
			case "service":
				if slices.Contains([]string{"api", "streamer", "worker"}, value) {
					fields[key] = slog.StringValue(value)
				}
				return
			default:
				return
			}
			if slices.Contains(policy.Allowed[key], value) {
				fields[key] = slog.StringValue(value)
			}
			return
		}
		if slices.Contains(policy.Numbers, a.Key) && finite(a.Value) {
			fields[a.Key] = a.Value
		}
		if a.Key == "stages" && a.Value.Kind() == slog.KindAny {
			if stages, ok := a.Value.Any().(map[string]float64); ok {
				for key, value := range stages {
					key = "stage_" + key + "_ms"
					if slices.Contains(policy.Numbers, key) && !math.IsNaN(value) && !math.IsInf(value, 0) {
						fields[key] = slog.Float64Value(value)
					}
				}
			}
		}
	}
	for _, a := range h.attrs {
		add(a)
	}
	if !h.grouped {
		r.Attrs(func(a slog.Attr) bool { add(a); return true })
	}
	if _, ok := fields["service"]; !ok {
		fields["service"] = slog.StringValue("api")
	}
	// Callers cannot override event or process identity through attributes.
	fields["event"] = slog.StringValue(event)
	fields["instance"] = slog.StringValue(h.instance)
	fields["release"] = slog.StringValue(h.release)
	for key, value := range fields {
		out.AddAttrs(slog.Attr{Key: key, Value: value})
	}
	return h.output.Handle(ctx, out)
}
func finite(v slog.Value) bool {
	switch v.Kind() {
	case slog.KindInt64, slog.KindUint64:
		return true
	case slog.KindFloat64:
		return !math.IsNaN(v.Float64()) && !math.IsInf(v.Float64(), 0)
	default:
		return false
	}
}
