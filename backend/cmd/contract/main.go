// contract exposes the implementation to the differential test runner. It has
// no database/network access and never accepts filesystem paths from input.
package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/filetype"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"os"
	"time"
)

type request struct {
	Operation string            `json:"operation"`
	Filename  string            `json:"filename"`
	Content   string            `json:"content"`
	Options   anonymize.Options `json:"options"`
	Context   anonymize.Context `json:"context"`
	Keys      string            `json:"keys"`
	Active    string            `json:"active"`
	Owner     string            `json:"owner"`
	Provider  string            `json:"provider"`
	Purpose   string            `json:"purpose"`
	Envelope  security.Envelope `json:"envelope"`
}

func run(r request) (any, error) {
	if r.Operation == "classify" {
		data, e := base64.StdEncoding.DecodeString(r.Content)
		return map[string]bool{"text": filetype.Text(r.Filename, data)}, e
	}
	if r.Operation == "encrypt" || r.Operation == "decrypt" {
		c, err := security.NewCipher(r.Keys, r.Active)
		if err != nil {
			return nil, err
		}
		if r.Operation == "encrypt" {
			return c.Encrypt(r.Content, r.Owner, r.Provider, r.Purpose)
		}
		value, err := c.Decrypt(r.Envelope, r.Owner, r.Provider, r.Purpose)
		return map[string]string{"content": value}, err
	}
	e, err := anonymize.New(r.Options, r.Context)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if r.Operation == "bytes" {
		data, err := base64.StdEncoding.DecodeString(r.Content)
		if err != nil {
			return nil, err
		}
		out, changed, err := e.Bytes(ctx, data, anonymize.MaxOutput)
		return map[string]any{"content": base64.StdEncoding.EncodeToString(out), "changed": changed}, err
	}
	if r.Operation == "path" {
		s, err := e.Path(ctx, r.Content)
		return map[string]string{"content": s}, err
	}
	return e.Transform(ctx, r.Content, anonymize.MaxOutput)
}
func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), anonymize.MaxInput+1024*1024)
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	for scanner.Scan() {
		var r request
		if json.Unmarshal(scanner.Bytes(), &r) != nil {
			enc.Encode(map[string]string{"error": "invalid_request"})
			continue
		}
		result, err := run(r)
		if err != nil {
			enc.Encode(map[string]string{"error": err.Error()})
		} else {
			enc.Encode(result)
		}
	}
	if scanner.Err() != nil {
		fmt.Fprintln(os.Stderr, "request_too_large")
		os.Exit(1)
	}
}
