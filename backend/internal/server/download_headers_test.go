package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestDownloadHeaderContracts(t *testing.T) {
	data, err := os.ReadFile("testdata/download-headers.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Name, Expected string }
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got := downloadDisposition(c.Name)
			if got != c.Expected {
				t.Fatalf("got %q, want %q", got, c.Expected)
			}
			if strings.ContainsAny(got, "\r\n\x00") {
				t.Fatalf("unsafe header %q", got)
			}
		})
	}
}

// HTTP/1's net/http writer suppresses canonical Content-Type on 304. The
// public file route uses this spelling to retain Express attachment metadata;
// verify it remains valid and singular on both supported wire protocols.
func TestFileNotModifiedMIMEProtocols(t *testing.T) {
	for _, h2 := range []bool{false, true} {
		t.Run(fmt.Sprint(h2), func(t *testing.T) {
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header()["content-type"] = []string{"application/octet-stream"}
				w.Header().Set("Content-Disposition", downloadDisposition("研究.txt"))
				w.WriteHeader(http.StatusNotModified)
			}))
			server.EnableHTTP2 = h2
			server.StartTLS()
			defer server.Close()
			response, err := server.Client().Get(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil || len(body) != 0 || response.StatusCode != 304 {
				t.Fatal(response.StatusCode, string(body), err)
			}
			if got := response.Header.Values("Content-Type"); len(got) != 1 || got[0] != "application/octet-stream" {
				t.Fatal(response.Header)
			}
			if response.ProtoMajor != map[bool]int{false: 1, true: 2}[h2] {
				t.Fatal(response.Proto)
			}
		})
	}
}
