package storage

import (
	"context"
	"encoding/xml"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestS3Protocol(t *testing.T) {
	objects := map[string]string{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/bucket/")
		switch {
		case r.Method == "PUT":
			b, e := io.ReadAll(r.Body)
			if e != nil {
				t.Error(e)
			}
			objects[key] = string(b)
			w.Header().Set("ETag", `"fixture"`)
		case r.Method == "GET" && r.URL.Query().Get("list-type") == "2":
			type item struct {
				Key  string
				Size int
			}
			result := struct {
				XMLName     xml.Name `xml:"ListBucketResult"`
				IsTruncated bool
				Contents    []item
			}{Contents: []item{}}
			for k, v := range objects {
				if strings.HasPrefix(k, r.URL.Query().Get("prefix")) {
					result.Contents = append(result.Contents, item{k, len(v)})
				}
			}
			xml.NewEncoder(w).Encode(result)
		case r.Method == "HEAD":
			value, ok := objects[key]
			if !ok {
				w.WriteHeader(404)
				return
			}
			w.Header().Set("Content-Length", strconv.Itoa(len(value)))
		case r.Method == "GET":
			value, ok := objects[key]
			if !ok {
				w.WriteHeader(404)
				return
			}
			io.WriteString(w, value)
		case r.Method == "DELETE":
			delete(objects, key)
			w.WriteHeader(204)
		case r.Method == "POST" && r.URL.Query().Has("delete"):
			var payload struct {
				Objects []struct{ Key string } `xml:"Object"`
			}
			if e := xml.NewDecoder(r.Body).Decode(&payload); e != nil {
				t.Error(e)
			}
			for _, o := range payload.Objects {
				delete(objects, o.Key)
			}
			io.WriteString(w, "<DeleteResult/>")
		default:
			t.Errorf("unexpected S3 request %s %s", r.Method, r.URL)
			w.WriteHeader(500)
		}
	}))
	defer api.Close()
	s, e := New(Config{Kind: "s3", Bucket: "bucket", Region: "test", Endpoint: api.URL, ID: "synthetic", Secret: "synthetic"})
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	ctx := context.Background()
	t.Run("exact deletion preserves descendants and batches requests", func(t *testing.T) {
		paths := make([]string, 1001)
		for i := range paths {
			paths[i] = "old/" + strconv.Itoa(i)
			objects["snapshot/original/"+paths[i]] = "old"
		}
		objects["snapshot/original/old/0/new"] = "new"
		if err := s.RemoveFiles(ctx, "snapshot", paths); err != nil {
			t.Fatal(err)
		}
		if len(objects) != 1 || objects["snapshot/original/old/0/new"] != "new" {
			t.Fatal("descendant removed or old objects retained", objects)
		}
		delete(objects, "snapshot/original/old/0/new")
	})

	for _, repo := range []string{"repo", "repository"} {
		if e = s.Put(ctx, repo, "file", strings.NewReader("complete"), 8, 20); e != nil {
			t.Fatal(e)
		}
	}
	if size, err := s.Size(ctx, "repo", "file"); err != nil || size != 8 {
		t.Fatal(size, err)
	}
	if _, err := s.Size(ctx, "repo", "missing"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("missing HEAD", err)
	}
	if e = s.Put(ctx, "repo", "file", strings.NewReader("short"), 8, 20); e == nil {
		t.Fatal("short write published")
	}
	r, e := s.Read(ctx, "repo", "file")
	if e != nil {
		t.Fatal(e)
	}
	b, e := io.ReadAll(r)
	r.Close()
	if e != nil || string(b) != "complete" {
		t.Fatalf("%q %v", b, e)
	}
	entries, e := s.List(ctx, "repo")
	if e != nil || len(entries) != 1 || entries[0].Path != "file" {
		t.Fatalf("%v %v", entries, e)
	}
	if e = s.Remove(ctx, "repo", ""); e != nil {
		t.Fatal(e)
	}
	if _, ok := objects["repo/original/file"]; ok {
		t.Fatal("object not deleted")
	}
	if objects["repository/original/file"] != "complete" {
		t.Fatal("adjacent prefix removed")
	}
}

func TestS3RemoveFilesRejectsPartialFailure(t *testing.T) {
	requests := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != "POST" || !r.URL.Query().Has("delete") {
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
		}
		io.WriteString(w, `<DeleteResult><Error><Key>repo/original/file</Key><Code>AccessDenied</Code></Error></DeleteResult>`)
	}))
	defer api.Close()
	s, err := New(Config{Kind: "s3", Bucket: "bucket", Region: "test", Endpoint: api.URL, ID: "synthetic", Secret: "synthetic"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.RemoveFiles(context.Background(), "repo", []string{"file", "../escape"}); err == nil || requests != 0 {
		t.Fatal("validation allowed partial deletion", err, requests)
	}
	if err := s.RemoveFiles(context.Background(), "repo", []string{"file"}); err == nil || err.Error() != "storage_delete_failed" {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatal(requests)
	}
}
