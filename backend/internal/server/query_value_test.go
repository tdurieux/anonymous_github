package server

import (
	"encoding/json"
	"os"
	"testing"
)

func TestExpressExtendedQueryContracts(t *testing.T) {
	data, err := os.ReadFile("testdata/query-values.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		Query, Value   string
		Error          bool
		Scalar, Truthy bool
	}
	if err = json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		value := parseExtendedQuery(row.Query).object["days"]
		_, scalar := value.scalarValue()
		if scalar != row.Scalar || value.truthy() != row.Truthy {
			t.Errorf("query %q: scalar=%v truthy=%v, want scalar=%v truthy=%v", row.Query, scalar, value.truthy(), row.Scalar, row.Truthy)
		}
		got, err := extendedQueryString(row.Query, "days")
		if (err != nil) != row.Error || (err == nil && got != row.Value) {
			t.Errorf("query %q: got %q error=%v, want %q error=%v", row.Query, got, err, row.Value, row.Error)
		}
	}
}
