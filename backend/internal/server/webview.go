package server

import (
	"encoding/json"
	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"github.com/tdurieux/anonymous_github/backend/internal/filetype"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"html"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
)

var pageIndexPriority = []string{"index.html", "index.htm", "index.md", "index.txt", "index.org", "index.1st", "index", "readme.md", "readme.txt", "readme.org", "readme.1st", "readme"}

func (s *Server) webview(q *request) (any, error) {
	q.W.Header().Set("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-forms allow-modals")
	q.W.Header().Set("Cache-Control", "private, no-cache, must-revalidate")
	r, e := q.resource("repo", false)
	if e != nil {
		return nil, e
	}
	if e = s.checkResource(q.ctx(), "repo", r); e != nil {
		return nil, e
	}
	if _, e = s.authorizeContent(q.ctx(), r); e != nil {
		return nil, e
	}
	opt := obj(r["options"])
	page := obj(opt["pageSource"])
	if !boolean(opt["page"]) || len(page) == 0 {
		return nil, fail("page_not_activated", 400)
	}
	if str(page["branch"]) != str(obj(r["source"])["branch"]) {
		return nil, fail("page_not_supported_on_different_branch", 400)
	}
	root := strings.TrimPrefix(str(page["path"]), "/")
	if root == "." {
		root = ""
	}
	if root != "" {
		if _, e = security.RelativePath(root); e != nil {
			return nil, fail("invalid_path", 400)
		}
	}
	requested := strings.TrimSuffix(q.Params["path"], "/")
	if requested != "" {
		if _, e = security.RelativePath(requested); e != nil {
			return nil, fail("invalid_path", 400)
		}
	}
	requested = path.Join(root, requested)
	if requested == "." {
		requested = ""
	}
	selected, e := s.indexedWebFile(q.ctx(), r, requested)
	if e != nil {
		return nil, e
	}
	children := map[string]M{}
	// File requests need only one indexed entry. Directory/index rendering keeps
	// the existing listing behavior, including collisions among child paths.
	if selected == nil || selected["size"] == nil {
		selected = nil
		engine, e := s.engine(r, "repo")
		if e != nil {
			return nil, e
		}
		rows, e := s.Store.list(q.ctx(), "files", M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r)}, 100000, nil)
		if e != nil {
			return nil, e
		}
		for _, row := range rows {
			anonymous, e := engine.Path(q.ctx(), path.Join(str(row["path"]), str(row["name"])))
			if e != nil {
				return nil, e
			}
			if anonymous == requested {
				if selected != nil {
					return nil, fail("ambiguous_anonymized_path", 409)
				}
				selected = row
			}
			parent := path.Dir(anonymous)
			if parent == "." {
				parent = ""
			}
			if parent == requested {
				if children[path.Base(anonymous)] != nil {
					return nil, fail("ambiguous_anonymized_path", 409)
				}
				children[path.Base(anonymous)] = row
			}
		}
	}
	if selected == nil || selected["size"] == nil {
		if !strings.Contains(q.R.Header.Get("Accept"), "text/html") {
			return nil, fail("file_not_found", 404)
		}
		for _, wanted := range pageIndexPriority {
			for name, row := range children {
				if strings.EqualFold(name, wanted) && row["size"] != nil {
					selected = row
					break
				}
			}
			if selected != nil && selected["size"] != nil {
				break
			}
		}
		if selected == nil || selected["size"] == nil {
			var b strings.Builder
			b.WriteString("<!doctype html><html><head><title>Content</title></head><body><ul>")
			for name, row := range children {
				suffix := ""
				if row["size"] == nil {
					suffix = "/"
				}
				b.WriteString(`<li><a href="` + html.EscapeString(url.PathEscape(name)+suffix) + `">` + html.EscapeString(name+suffix) + `</a></li>`)
			}
			b.WriteString("</ul></body></html>")
			q.W.Header().Set("Content-Type", "text/html; charset=utf-8")
			q.W.Header().Set("Content-Length", strconv.Itoa(b.Len()))
			if q.R.Method != "HEAD" {
				io.WriteString(q.W, b.String())
			}
			return written{}, nil
		}
	}
	if !fileAllowed(str(selected["name"]), opt) {
		return nil, fail("file_not_supported", 400)
	}
	if number(selected["size"]) > anonymize.MaxInput {
		return nil, fail("file_too_big", 413)
	}
	ext := strings.ToLower(path.Ext(str(selected["name"])))
	ct := filetype.MIME(ext)
	if ext == ".md" {
		ct = "text/html; charset=utf-8"
	}
	if ct == "" || ext == ".ts" {
		ct = "text/plain; charset=utf-8"
	}
	q.W.Header().Set("Content-Type", ct)
	if q.R.Method == "HEAD" {
		return written{}, nil
	}
	response := &sharedResponse{accept: strings.Join(q.R.Header.Values("Accept-Encoding"), ", ")}
	// Markdown is wrapped in HTML; its cached source encoding cannot be sent.
	var delivery *sharedResponse
	if ext != ".md" {
		delivery = response
	}
	reader, cleanup, isText, e := s.transformedResponse(q.ctx(), r, selected, delivery)
	if response.eligible {
		sharedVary(q.W.Header())
	}
	if e == errSharedEncoding {
		q.W.Header().Set("Content-Length", "0")
		q.W.WriteHeader(http.StatusNotAcceptable)
		return written{}, nil
	}
	if e != nil {
		return nil, e
	}
	defer cleanup()
	if isText {
		q.W.Header().Set("Accept-Ranges", "none")
	}
	if current, e := s.Store.one(q.ctx(), collection("repo"), contentRevisionFilter(r)); e != nil {
		return nil, e
	} else if current == nil {
		return nil, fail("repository_changed", 409)
	}
	if ext == ".md" {

		const pageLimit = 8 * 1024 * 1024
		data, e := io.ReadAll(io.LimitReader(reader, pageLimit+1))
		if e != nil || len(data) > pageLimit {
			return nil, fail("page_too_large", 413)
		}
		payload, e := json.Marshal(M{"source": string(data)})
		if e != nil {
			return nil, e
		}
		io.WriteString(q.W, `<!doctype html><html><head><title>Content</title><link rel="stylesheet" href="/css/all.min.css"></head><body><div id="go-project-content" class="container p-3 file-content markdown-body"></div><script id="go-project-source" type="application/json">`)
		if _, e = q.W.Write(payload); e != nil {
			panic(http.ErrAbortHandler)
		}
		io.WriteString(q.W, `</script><noscript><pre>`+html.EscapeString(string(data))+`</pre></noscript><script defer src="/script/markdown.min.js"></script><script defer src="/script/go-project-page.js"></script></body></html>`)

	} else {
		handled := false
		if blob, ok := reader.(*blobcache.Reader); ok && response.eligible {
			handled, e = sendSharedBlob(q.ctx(), q.W, blob, response)
			if e != nil {
				if handled {
					panic(http.ErrAbortHandler)
				}
				return nil, e
			}
		}
		if !handled {
			if _, e = io.Copy(q.W, reader); e != nil {
				panic(http.ErrAbortHandler)
			}
		}
	}
	return written{}, nil
}

// Reuse the application's browser renderer so diagrams, math, syntax highlighting,
// sanitization and heading IDs stay identical after the server runtime changes.
const projectPageScript = `"use strict";(()=>{const source=document.getElementById("go-project-source"),target=document.getElementById("go-project-content");if(!source||!target)return;try{const data=JSON.parse(source.textContent);if(typeof data.source!=="string")return;if(window.MarkdownRenderer){target.innerHTML=window.MarkdownRenderer.render(data.source)}else{target.textContent=data.source}}catch{target.textContent="Unable to render this page."}source.remove()})();`

func (s *Server) projectPageScript(q *request) (any, error) {
	q.W.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	q.W.Header().Set("Cache-Control", "public, max-age=300")
	q.W.Header().Set("Content-Length", strconv.Itoa(len(projectPageScript)))
	if q.R.Method != "HEAD" {
		io.WriteString(q.W, projectPageScript)
	}
	return written{}, nil
}
