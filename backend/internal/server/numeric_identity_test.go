package server

import "testing"

func TestNumericIdentityFormatting(t *testing.T) {
	for _, c := range []struct {
		value float64
		want  string
	}{
		{7000123, "7000123"}, {1234567890123, "1234567890123"}, {1e20, "100000000000000000000"}, {1e21, "1e+21"}, {0.000001, "0.000001"}, {0.0000001, "1e-7"},
	} {
		if got := str(c.value); got != c.want {
			t.Fatalf("got %s; expected %s", got, c.want)
		}
	}
}
