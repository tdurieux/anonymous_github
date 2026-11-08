package server

import (
	"go.mongodb.org/mongo-driver/v2/bson"
	"testing"
	"time"
)

func TestStoredDatePresence(t *testing.T) {
	zero := time.Time{}
	for _, value := range []any{zero, bson.NewDateTimeFromTime(zero), "0001-01-01T00:00:00Z", "0001-01-01"} {
		parsed, valid := storedDate(value)
		if !valid || !parsed.Equal(zero) {
			t.Fatalf("valid zero date lost: %v %v", value, valid)
		}
	}
	for _, value := range []any{nil, "", "invalid", false, 0, M{}} {
		if _, valid := storedDate(value); valid {
			t.Fatalf("invalid stored date accepted: %#v", value)
		}
	}
	earlier := time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, values := range [][]any{{zero}, {nil, earlier, zero}, {earlier}} {
		got, ok := latestStoredDate(values...).(time.Time)
		want := zero
		if len(values) == 1 {
			want = values[0].(time.Time)
		}
		if !ok || !got.Equal(want) {
			t.Fatalf("latest valid date lost: %v", got)
		}
	}
	if latestStoredDate(nil, "invalid") != nil {
		t.Fatal("missing dates became a timestamp")
	}
}

func TestContentGenerationDatePresence(t *testing.T) {
	absent := contentPrefix(M{"treeGeneration": "generation"})
	for _, value := range []any{time.Time{}, bson.NewDateTimeFromTime(time.Time{}), "0001-01-01T00:00:00Z"} {
		record := M{"treeGeneration": "generation", "anonymizeDate": value}
		if got := contentGeneration(record); got != "generation:0001-01-01T00:00:00.000Z" {
			t.Fatal(got)
		}
		if contentPrefix(record) == absent {
			t.Fatal("dated and undated content share an identity")
		}
	}
}
