package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// responseJSON normalizes native dates at the HTTP boundary only. Persistence,
// signatures, cache fingerprints and upstream requests keep their own encodings.
// Provider payloads use string-keyed maps and arrays, as do MongoDB documents.
// Strings are deliberately untouched: date-looking file contents are not dates.
func responseJSON(value any) any { return responseJSONAt(value, 0) }

func responseJSONAt(value any, depth int) any {
	if depth > 100 {
		return invalidResponseDepth{}
	}
	switch v := value.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil
		}
		return v
	case float32:
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			return nil
		}
		return v
	case time.Time:
		return responseDate(v)
	case *time.Time:
		if v == nil {
			return nil
		}
		return responseDate(*v)
	case bson.DateTime:
		return responseDate(v.Time())
	case *bson.DateTime:
		if v == nil {
			return nil
		}
		return responseDate(v.Time())
	case M:
		if v == nil {
			return v
		}
		out := make(M, len(v))
		for k, item := range v {
			out[k] = responseJSONAt(item, depth+1)
		}
		return out
	case map[string]any:
		if v == nil {
			return v
		}
		out := make(map[string]any, len(v))
		for k, item := range v {
			out[k] = responseJSONAt(item, depth+1)
		}
		return out
	case []M:
		if v == nil {
			return v
		}
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = responseJSONAt(item, depth+1)
		}
		return out
	case []any:
		if v == nil {
			return v
		}
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = responseJSONAt(item, depth+1)
		}
		return out
	case bson.A:
		if v == nil {
			return v
		}
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = responseJSONAt(item, depth+1)
		}
		return out
	case bson.D:
		if v == nil {
			return v
		}
		out := make(bson.D, len(v))
		for i, entry := range v {
			out[i] = bson.E{Key: entry.Key, Value: responseJSONAt(entry.Value, depth+1)}
		}
		return out
	default:
		// Adapters may use typed maps/slices rather than []any. Preserve custom
		// JSON encoders and byte slices, whose wire representations differ.
		if value == nil {
			return nil
		}
		if _, custom := value.(json.Marshaler); custom {
			return value
		}
		rv := reflect.ValueOf(value)
		switch rv.Kind() {
		case reflect.Float32, reflect.Float64:
			if math.IsNaN(rv.Float()) || math.IsInf(rv.Float(), 0) {
				return nil
			}
			return value
		case reflect.Map:
			if rv.IsNil() || rv.Type().Key().Kind() != reflect.String {
				return value
			}
			out := make(map[string]any, rv.Len())
			for _, key := range rv.MapKeys() {
				out[key.String()] = responseJSONAt(rv.MapIndex(key).Interface(), depth+1)
			}
			return out
		case reflect.Slice, reflect.Array:
			if rv.Kind() == reflect.Slice && (rv.IsNil() || rv.Type().Elem().Kind() == reflect.Uint8) {
				return value
			}
			out := make([]any, rv.Len())
			for i := range out {
				out[i] = responseJSONAt(rv.Index(i).Interface(), depth+1)
			}
			return out
		case reflect.Pointer:
			if rv.IsNil() {
				return nil
			}
			return responseJSONAt(rv.Elem().Interface(), depth+1)
		}
		return value
	}
}

func responseDate(value time.Time) any {
	// JavaScript Date's supported range is inclusive and bounded in milliseconds.
	utc := value.UTC()
	if utc.Before(time.UnixMilli(-8640000000000000)) || utc.After(time.UnixMilli(8640000000000000)) {
		return nil
	}
	if year := utc.Year(); year < 0 || year > 9999 {
		return fmt.Sprintf("%+07d-%s", year, utc.Format("01-02T15:04:05.000Z"))
	}
	return utc.Format("2006-01-02T15:04:05.000Z")
}

type invalidResponseDepth struct{}

func (invalidResponseDepth) MarshalJSON() ([]byte, error) {
	return nil, errors.New("response_nesting_limit")
}
