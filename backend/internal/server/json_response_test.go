package server

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestJavaScriptDateOutput(t *testing.T) {
	raw, err := os.ReadFile("testdata/dates.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Milliseconds int64
		Expected     any
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		date := time.UnixMilli(c.Milliseconds)
		bsonDate := bson.DateTime(c.Milliseconds)
		for _, input := range []any{date, date.In(time.FixedZone("offset", 19800)), &date, bsonDate, &bsonDate} {
			w := httptest.NewRecorder()
			writeJSON(w, M{"date": input})
			var actual M
			if err := json.Unmarshal(w.Body.Bytes(), &actual); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(actual["date"], c.Expected) {
				t.Fatalf("%d (%T): got %s; expected %#v", c.Milliseconds, input, w.Body, c.Expected)
			}
		}
	}
}

func TestResponseJSONNestedDates(t *testing.T) {
	date := time.Date(2026, 1, 2, 3, 4, 5, 123456789, time.UTC)
	id := bson.NewObjectID()
	var nilDate *time.Time
	input := M{
		"rows":       []M{{"date": date}},
		"provider":   map[string]any{"comments": []any{M{"date": &date}}},
		"bson":       bson.A{bson.NewDateTimeFromTime(date)},
		"dateString": "2026-01-02T03:04:05Z",
		"id":         id, "bytes": []byte{1, 2, 3}, "raw": json.RawMessage(`{"date":"unchanged"}`),
		"nulls": []any{nilDate, M(nil), []M(nil), []any(nil), bson.A(nil), map[string]any(nil)},
		"empty": []any{}, "integer": int64(9007199254740993),
	}
	w := httptest.NewRecorder()
	writeJSON(w, input)
	var actual M
	if err := json.Unmarshal(w.Body.Bytes(), &actual); err != nil {
		t.Fatal(err)
	}
	expected := M{
		"rows":       []any{map[string]any{"date": "2026-01-02T03:04:05.123Z"}},
		"provider":   map[string]any{"comments": []any{map[string]any{"date": "2026-01-02T03:04:05.123Z"}}},
		"bson":       []any{"2026-01-02T03:04:05.123Z"},
		"dateString": "2026-01-02T03:04:05Z", "id": id.Hex(), "bytes": "AQID",
		"raw": map[string]any{"date": "unchanged"}, "nulls": []any{nil, nil, nil, nil, nil, nil},
		"empty": []any{}, "integer": float64(9007199254740993),
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("got %s; expected %#v", w.Body, expected)
	}
	if !reflect.DeepEqual(input["rows"].([]M)[0]["date"], date) {
		t.Fatal("response mutated stored data")
	}
	// Preserve integer bytes without a lossy JSON round trip in the implementation.
	var exact map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &exact); err != nil {
		t.Fatal(err)
	}
	if string(exact["integer"]) != "9007199254740993" {
		t.Fatal(string(exact["integer"]))
	}
	if w.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatal(w.Header())
	}
}

func TestTypedProviderPayloadDates(t *testing.T) {
	type dates map[string]time.Time
	type rows []map[string]any
	type binary []byte
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	typedMap := dates{"created": stamp}
	cases := []struct {
		value    any
		expected string
	}{
		{rows{{"date": stamp}}, `[{"date":"2026-01-02T03:04:05.000Z"}]`},
		{typedMap, `{"created":"2026-01-02T03:04:05.000Z"}`},
		{&typedMap, `{"created":"2026-01-02T03:04:05.000Z"}`},
		{[]time.Time{stamp}, `["2026-01-02T03:04:05.000Z"]`},
		{[1]time.Time{stamp}, `["2026-01-02T03:04:05.000Z"]`},
		{[]*time.Time{nil, &stamp}, `[null,"2026-01-02T03:04:05.000Z"]`},
		{[]bson.DateTime{bson.NewDateTimeFromTime(stamp)}, `["2026-01-02T03:04:05.000Z"]`},
		{dates(nil), `null`}, {rows(nil), `null`}, {rows{}, `[]`},
		{binary{1, 2, 3}, `"AQID"`},
		{json.RawMessage(`{"date":"untouched"}`), `{"date":"untouched"}`},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		writeJSON(w, c.value)
		if strings.TrimSpace(w.Body.String()) != c.expected {
			t.Fatalf("%T: %s; expected %s", c.value, w.Body, c.expected)
		}
	}
	if !typedMap["created"].Equal(stamp) {
		t.Fatal("provider payload mutated")
	}
	// Ordered BSON documents retain their normal JSON shape, with only dates changed.
	original := bson.D{{Key: "date", Value: stamp}}
	expected, err := json.Marshal(bson.D{{Key: "date", Value: "2026-01-02T03:04:05.000Z"}})
	if err != nil {
		t.Fatal(err)
	}
	actual, err := json.Marshal(responseJSON(original))
	if err != nil || string(actual) != string(expected) {
		t.Fatal(string(actual), string(expected), err)
	}
	if _, ok := original[0].Value.(time.Time); !ok {
		t.Fatal("BSON document mutated")
	}
}
