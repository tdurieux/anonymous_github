package server

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
)

func TestJSONHTTPContracts(t *testing.T) {
	raw, err := os.ReadFile("testdata/json-http.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Method, Match, Control, Since, Modified, Preset string
		Status                                                int
		Value                                                 any
		Expected                                              struct {
			Status                   int
			ETag, Type, Length, Body string
		}
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		index, _ := strconv.Atoi(r.Header.Get("X-Fixture"))
		c := cases[index]
		response := &compressionWriter{ResponseWriter: w, request: r}
		if c.Modified != "" {
			response.Header().Set("Last-Modified", c.Modified)
		}
		if c.Preset != "" {
			response.Header().Set("ETag", c.Preset)
		}
		writeJSONStatus(response, c.Value, c.Status)
		if err := response.finish(); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	transport := &http.Transport{DisableCompression: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	for i, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			request, _ := http.NewRequest(c.Method, server.URL, nil)
			request.Header.Set("X-Fixture", strconv.Itoa(i))
			if c.Match != "" {
				request.Header.Set("If-None-Match", c.Match)
			}
			if c.Control != "" {
				request.Header.Set("Cache-Control", c.Control)
			}
			if c.Since != "" {
				request.Header.Set("If-Modified-Since", c.Since)
			}
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != c.Expected.Status || response.Header.Get("ETag") != c.Expected.ETag || response.Header.Get("Content-Type") != c.Expected.Type || response.Header.Get("Content-Length") != c.Expected.Length || string(body) != c.Expected.Body {
				t.Fatalf("got status=%d headers=%v body=%q; want %+v", response.StatusCode, response.Header, body, c.Expected)
			}
		})
	}
}

type failedJSON struct{}

func (failedJSON) MarshalJSON() ([]byte, error) { return nil, errors.New("synthetic-private-value") }
func TestJSONSerializationFailures(t *testing.T) {
	cyclic := M{}
	cyclic["self"] = cyclic
	for _, value := range []any{failedJSON{}, M{"channel": make(chan int)}, cyclic} {
		recorder := httptest.NewRecorder()
		recorder.Header().Set("ETag", `"stale"`)
		writeJSONStatus(recorder, value, 201)
		if recorder.Code != 500 || recorder.Body.String() != `{"error":"internal_error"}` || strings.Contains(recorder.Body.String(), "private") || recorder.Header().Get("ETag") == `"stale"` {
			t.Fatal(recorder.Code, recorder.Header(), recorder.Body.String())
		}
	}
	recorder := httptest.NewRecorder()
	writeJSON(recorder, M{"values": []any{math.NaN(), math.Inf(1), math.Inf(-1), float32(math.Inf(1))}})
	if recorder.Code != 200 || recorder.Body.String() != `{"values":[null,null,null,null]}` {
		t.Fatal(recorder.Code, recorder.Body.String())
	}
}
