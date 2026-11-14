package server

import (
	"math"
	"strings"
	"testing"
)

func TestTermCoercionRejectsUnsafeInputs(t *testing.T) {
	for _, input := range []any{nil, M{}, []any{}, math.Inf(1), math.NaN(), strings.Repeat("x", 8193)} {
		_, err := validatedOptions("repo", M{"terms": []any{input}, "options": M{}})
		api, ok := err.(*APIError)
		if !ok || api.Code != "invalid_terms_format" {
			t.Fatalf("%T: %v", input, err)
		}
	}
	terms := make([]any, 1001)
	for i := range terms {
		terms[i] = true
	}
	_, err := validatedOptions("repo", M{"terms": terms, "options": M{}})
	api, ok := err.(*APIError)
	if !ok || api.Code != "too_many_anonymization_terms" {
		t.Fatal(err)
	}
	if got, ok := termString(math.Copysign(0, -1)); !ok || got != "0" {
		t.Fatal(got, ok)
	}
}
