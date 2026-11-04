package server

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/blobcache"
	"github.com/tdurieux/anonymous_github/backend/internal/filetype"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

var imageExtensions = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".svg": true, ".ico": true, ".bmp": true, ".tiff": true, ".tif": true, ".webp": true, ".avif": true, ".heif": true, ".heic": true}

func fileAllowed(name string, opt M) bool {
	ext := strings.ToLower(path.Ext(name))
	if ext == ".pdf" && !boolean(opt["pdf"]) {
		return false
	}
	return !imageExtensions[ext] || boolean(opt["image"])
}
func scriptableFile(name string) bool {
	mimeType := strings.Split(filetype.MIME(path.Ext(name)), ";")[0]
	if mimeType == "text/html" || mimeType == "text/xml" || mimeType == "application/xml" || strings.HasSuffix(mimeType, "+xml") || mimeType == "message/rfc822" || mimeType == "multipart/related" {
		return true
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".html", ".htm", ".xhtml", ".xht", ".svg", ".xml", ".xsl", ".xslt", ".mhtml", ".mht":
		return true
	}
	return false
}
func textFile(name string, sample []byte) bool { return filetype.Text(name, sample) }
func (s *Server) blob(ctx context.Context, r, row M) (io.ReadCloser, error) {
	if number(row["size"]) > anonymize.MaxInput {
		return nil, fail("file_too_big", 413)
	}
	p, a, e := s.repositoryProvider(r)
	if e != nil {
		return nil, e
	}
	// Cached sources authorize at cache access and again after waits/fills.
	// Archive originals bypass that layer and need their own entry check.
	if a.Ref.Provider == "archive" {
		if e = s.authorizeMeasured(ctx, p, a); e != nil {
			return nil, e
		}
	}
	return s.cachedBlob(ctx, r, p, a, provider.Entry{Path: path.Join(str(row["path"]), str(row["name"])), Revision: str(row["sha"]), Size: number(row["size"])})
}
func (s *Server) transformed(ctx context.Context, r, row M) (io.Reader, func(), bool, error) {
	return s.transformedResponse(ctx, r, row, nil)
}
func (s *Server) transformedResponse(ctx context.Context, r, row M, response *sharedResponse) (io.Reader, func(), bool, error) {
	var body io.ReadCloser
	var err error
	if s.sourceCache != nil && number(row["size"]) <= anonymize.MaxInput {
		p, a, accessErr := s.repositoryProvider(r)
		if accessErr != nil {
			return nil, nil, false, accessErr
		}
		if a.Ref.Provider != "archive" {
			entry := provider.Entry{Path: path.Join(str(row["path"]), str(row["name"])), Revision: str(row["sha"]), Size: number(row["size"])}
			if _, err = security.RelativePath(entry.Path); err == nil {
				body, err = s.sharedSourceRead(ctx, r, p, a, entry, true)
			}
		} else {
			body, err = s.blob(ctx, r, row)
		}
	} else {
		body, err = s.blob(ctx, r, row)
	}
	if err != nil {
		return nil, nil, false, err
	}
	if err := s.markCachePresent(ctx, r); err != nil {
		body.Close()
		return nil, nil, false, err
	}
	if _, ok := body.(*blobcache.Reader); ok && s.resultCache != nil && response != nil {
		response.eligible = true
		response.encoding = sharedEncoding(response.accept, "gzip", "identity")
		if response.encoding == "" {
			body.Close()
			if _, err := s.authorizeContent(ctx, r); err != nil {
				return nil, nil, false, err
			}
			return nil, nil, false, errSharedEncoding
		}
	}
	return s.transformBody(ctx, r, row, body)
}

// transformBody consumes one authorized source entry, never the whole archive.
func (s *Server) transformBody(ctx context.Context, r, row M, body io.ReadCloser) (io.Reader, func(), bool, error) {
	reader := bufio.NewReader(body)
	sample, _ := reader.Peek(515)
	name := str(row["name"])
	isText := textFile(name, sample)
	if source, ok := body.(*blobcache.Reader); ok && s.resultCache != nil {
		opt, err := s.anonymizerOptions(r, "repo")
		if err != nil {
			body.Close()
			return nil, nil, isText, err
		}
		output, handled, err := s.sharedResult(ctx, r, row, source, isText, opt)
		if handled {
			body.Close()
			if err != nil {
				return nil, nil, isText, err
			}
			return output, func() { output.Close() }, isText, nil
		}
	}
	if !isText {
		file, e := os.CreateTemp("", "anonymous-go-binary-")
		if e != nil {
			body.Close()
			return nil, nil, false, e
		}
		cleanup := func() { file.Close(); os.Remove(file.Name()) }
		n, e := io.Copy(file, io.LimitReader(reader, anonymize.MaxInput+1))
		body.Close()
		if e != nil || n > anonymize.MaxInput {
			cleanup()
			return nil, nil, false, fail("storage_write_size_mismatch", 502)
		}
		if _, e = file.Seek(0, 0); e != nil {
			cleanup()
			return nil, nil, false, e
		}
		if err := s.activeContentCache(ctx, r); err != nil {
			cleanup()
			return nil, nil, false, err
		}
		if _, err := s.authorizeContent(ctx, r); err != nil {
			cleanup()
			return nil, nil, false, err
		}
		return file, cleanup, false, nil
	}
	opt, err := s.anonymizerOptions(r, "repo")
	if err != nil {
		body.Close()
		return nil, nil, false, err
	}
	scope, err := json.Marshal(contentRevisionFilter(r))
	if err != nil {
		body.Close()
		return nil, nil, true, err
	}
	file, _, cleanup, err := s.pool.Process(ctx, reader, anonymize.ProcessRequest{StageEvent: s.stageObserver(ctx), Options: opt, Context: anonymize.Context{Mask: s.Config.Mask, Hostname: s.Config.Hostname}, MaxOutput: anonymize.MaxOutput, CacheScope: string(scope), CacheOwner: str(r["repoId"]), CacheEvent: func(hit bool) {
		name := "legacy_result_miss"
		if hit {
			name = "legacy_result_hit"
		}
		s.observeCache(ctx, name, 0, 0)
	}})
	body.Close()
	if err != nil {
		return nil, nil, true, transformFailure(err)
	}
	if err := s.activeContentCache(ctx, r); err != nil {
		cleanup()
		s.pool.RemoveResults(str(r["repoId"]))
		return nil, nil, true, err
	}
	if _, err := s.authorizeContent(ctx, r); err != nil {
		cleanup()
		s.pool.RemoveResults(str(r["repoId"]))
		return nil, nil, true, err
	}
	return file, cleanup, true, nil
}
func (s *Server) file(q *request) (any, error) {
	requested, err := security.RelativePath(q.Params["path"])
	if err != nil {
		return nil, fail("invalid_path", 400)
	}
	r, err := q.resource("repo", false)
	if err != nil {
		return nil, err
	}
	if err = s.checkResource(q.ctx(), "repo", r); err != nil {
		return nil, err
	}
	selected, err := s.indexedFile(q.ctx(), r, requested)
	if err != nil {
		return nil, err
	}
	if selected == nil {
		return nil, fail("file_not_found", 404)
	}
	name := str(selected["name"])
	if !fileAllowed(name, obj(r["options"])) {
		return nil, fail("file_not_supported", 403)
	}
	if number(selected["size"]) > anonymize.MaxInput {
		return nil, fail("file_too_big", 413)
	}
	// These headers also belong on HEAD and conditional responses.
	if parseExtendedQuery(q.R.URL.RawQuery).object["download"].truthy() {
		q.W.Header().Set("Content-Disposition", downloadDisposition(requested))
		attachmentType := filetype.MIME(path.Ext(requested))
		if attachmentType == "" {
			attachmentType = "application/octet-stream"
		}
		q.W.Header().Set("Content-Type", attachmentType)
	} else if scriptableFile(name) || scriptableFile(requested) {
		q.W.Header().Set("Content-Security-Policy", "sandbox allow-popups allow-forms allow-modals")
	}
	fingerprint, _ := json.Marshal([]any{obj(r["source"])["commit"], selected["sha"], requested, r["options"], s.Config.Mask, s.Config.Hostname, "go-v1"})
	hash := sha1.Sum(fingerprint)
	etag := `"f-` + hex.EncodeToString(hash[:]) + `"`
	if s.Config.SharedCacheEnabled {
		etag = "W/" + etag
		sharedVary(q.W.Header())
	}
	q.W.Header().Set("ETag", etag)
	q.W.Header().Set("Cache-Control", "private, no-cache, must-revalidate")
	// Body reads authorize in the cache layer. Responses without a body must
	// still authorize here, including conditional requests that return 304.
	fresh := responseFresh(q.R, 200, q.W.Header())
	if fresh || q.R.Method == http.MethodHead {
		if _, err = s.authorizeContent(q.ctx(), r); err != nil {
			return nil, err
		}
	}
	if fresh {
		// Express's manual status(304).end() retains attachment MIME metadata.
		// net/http suppresses the canonical Content-Type key on HTTP/1 304s;
		// use its equivalent lowercase spelling only for this metadata response.
		if values := q.W.Header().Values("Content-Type"); len(values) != 0 {
			q.W.Header()["content-type"] = values
			q.W.Header().Del("Content-Type")
		}
		q.W.WriteHeader(304)
		return written{}, nil
	}
	contentType := filetype.MIME(path.Ext(name))
	if strings.HasSuffix(name, ".ts") || contentType == "" && textFile(name, nil) {
		contentType = "text/plain; charset=utf-8"
	}
	if contentType != "" {
		q.W.Header().Set("Content-Type", contentType)
	}
	// The public TypeScript route ends HEAD before sendSharedContent. Encoding
	// negotiation and content reads belong only to the GET response path.
	if q.R.Method == "HEAD" {
		q.W.WriteHeader(200)
		return written{}, nil
	}
	response := &sharedResponse{accept: strings.Join(q.R.Header.Values("Accept-Encoding"), ", ")}
	reader, cleanup, text, err := s.transformedResponse(q.ctx(), r, selected, response)
	if response.eligible {
		sharedVary(q.W.Header())
	}
	if err == errSharedEncoding {
		q.W.Header().Set("Content-Length", "0")
		q.W.WriteHeader(http.StatusNotAcceptable)
		return written{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer cleanup()
	current, e := s.Store.one(q.ctx(), collection("repo"), contentRevisionFilter(r))
	if e != nil {
		return nil, e
	}
	if current == nil {
		return nil, fail("repository_changed", 409)
	}
	if text {
		q.W.Header().Set("Accept-Ranges", "none")
		if contentType == "" {
			q.W.Header().Set("Content-Type", "text/plain; charset=utf-8")
		}
	} else if contentType == "" {
		q.W.Header().Set("Content-Type", "application/octet-stream")
	}
	handled := false
	if blob, ok := reader.(*blobcache.Reader); ok && response.eligible {
		handled, err = sendSharedBlob(q.ctx(), q.W, blob, response)
		if err != nil {
			if handled {
				panic(http.ErrAbortHandler)
			}
			return nil, err
		}
	}
	if !handled {
		if _, err = io.Copy(q.W, reader); err != nil {
			panic(http.ErrAbortHandler)
		}
	}
	s.Store.update(q.ctx(), "anonymizedrepositories", M{"_id": r["_id"]}, M{"$inc": M{"pageView": 1}, "$set": M{"lastView": time.Now()}})
	return written{}, nil
}
func (s *Server) zip(q *request) (any, error) {
	if !s.Config.Download {
		return nil, fail("download_not_enabled", 403)
	}
	r, err := q.resource("repo", false)
	if err != nil {
		return nil, err
	}
	if err = s.checkResource(q.ctx(), "repo", r); err != nil {
		return nil, err
	}
	if q.R.Method == http.MethodHead {
		q.W.Header().Set("Content-Disposition", downloadDisposition(str(r["repoId"])+".zip"))
		q.W.Header().Set("Content-Type", "application/zip")
		q.W.WriteHeader(http.StatusOK)
		return written{}, nil
	}

	p, access, err := s.repositoryProvider(r)
	if err != nil {
		return nil, err
	}
	if archives, ok := p.(provider.Archives); ok {
		return s.zipFromArchive(q, r, p, access, archives)
	}

	e, err := s.engine(r, "repo")
	if err != nil {
		return nil, err
	}
	// Consume bounded metadata batches instead of retaining the entire tree.
	// No limit: a successful ZIP must contain every eligible file.
	rows, err := s.Store.DB.Collection("files").Find(q.ctx(), M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r), "size": M{"$ne": nil}},
		options.Find().SetBatchSize(128).SetProjection(M{"_id": 0, "path": 1, "name": 1, "size": 1, "sha": 1}))
	if err != nil {
		return nil, err
	}
	defer rows.Close(q.ctx())
	if _, err = s.authorizeContent(q.ctx(), r); err != nil {
		return nil, err
	}
	q.W.Header().Set("Content-Disposition", downloadDisposition(str(r["repoId"])+".zip"))
	q.W.Header().Set("Content-Type", "application/zip")
	q.W.Header().Set("Cache-Control", "private, no-cache")
	// Nginx honors this per-response hint; other responses retain buffering.
	q.W.Header().Set("X-Accel-Buffering", "no")
	archive := newStreamZIP(q.W)
	seen := map[string]bool{}
	for rows.Next(q.ctx()) {
		var row M
		if err := rows.Decode(&row); err != nil {
			panic(http.ErrAbortHandler)
		}
		if !fileAllowed(str(row["name"]), obj(r["options"])) {
			continue
		}
		original := path.Join(str(row["path"]), str(row["name"]))
		name, err := e.Path(q.ctx(), original)
		if err != nil {
			panic(http.ErrAbortHandler)
		}
		if _, err = security.RelativePath(name); err != nil || seen[name] {
			panic(http.ErrAbortHandler)
		}
		seen[name] = true
		reader, cleanup, _, err := s.transformed(q.ctx(), r, row)
		if err != nil {
			panic(http.ErrAbortHandler)
		}
		if current, e := s.Store.one(q.ctx(), collection("repo"), contentRevisionFilter(r)); e != nil || current == nil {
			cleanup()
			panic(http.ErrAbortHandler)
		}
		err = archive.add(q.ctx(), name, reader)
		cleanup()
		if err != nil {
			panic(http.ErrAbortHandler)
		}
	}
	// A failed or cancelled cursor must never produce a valid, partial ZIP.
	if rows.Err() != nil || q.ctx().Err() != nil {
		panic(http.ErrAbortHandler)
	}
	if archive.archive.Close() != nil {
		panic(http.ErrAbortHandler)
	}
	return written{}, nil
}
func (s *Server) sourceRepository(mode string) handler {
	return func(q *request) (any, error) {
		id := q.Params["provider"]
		name := q.R.URL.Query().Get("name")
		if id == "" {
			id = "github"
			name = q.Params["owner"] + "/" + q.Params["repo"]
		}
		p, e := s.providers.Repositories(id)
		if e != nil {
			return nil, providerFailure(e)
		}
		a, e := s.previewRepositoryAccess(q, p, id, name)
		if e != nil {
			return nil, e
		}
		if e = p.Authorize(q.ctx(), a); e != nil {
			return nil, e
		}
		var discovery provider.Discovery
		if mode != "metadata" {
			var supported bool
			discovery, supported = p.(provider.Discovery)
			if !supported {
				return nil, providerFailure(provider.ErrCapability)
			}
		}
		var r provider.Repository
		var cached M
		if previews, ok := p.(provider.RepositoryPreviews); ok {
			refresh, err := previewRefresh(q.R.URL.RawQuery)
			if err != nil {
				return nil, err
			}
			var snapshot *provider.Repository
			if !refresh {
				cached, snapshot, e = s.previewMetadataSnapshot(q, id, a)
				if e != nil {
					return nil, e
				}
			}
			r, e = previews.PreviewRepository(q.ctx(), a, snapshot)
		} else {
			r, e = p.Repository(q.ctx(), a)
		}
		if e != nil {
			return nil, e
		}
		if e := validateRepositoryIdentity(a, r); e != nil {
			return nil, e
		}
		a.Ref.ID, a.Ref.Name = r.ID, r.Name
		var metadata M
		if cached != nil {
			if str(cached["externalId"]) != externalRepositoryID(id, r.ID) {
				return nil, fail("connection_changed", 409)
			}
			metadata = providerRepositoryJSON(id, r, cached)
		} else {
			metadata, e = s.cacheProviderRepository(q, id, r)
			if e != nil {
				return nil, e
			}
		}
		if mode == "metadata" {
			return metadata, nil
		}
		d := discovery
		refresh, err := previewRefresh(q.R.URL.RawQuery)
		if err != nil {
			return nil, err
		}
		previews, cachedDiscovery := p.(provider.DiscoveryPreviews)
		if mode == "readme" {
			if selected, ok := p.(provider.SelectedReadmePreviews); ok {
				fallback := r.DefaultBranch
				if fallback == "" {
					fallback = "master"
				}
				value, err := selected.PreviewSelectedReadme(q.ctx(), a, previewBranchMatch(q.R.URL.RawQuery, fallback), refresh)
				if err != nil {
					return nil, err
				}
				return q.text(value), nil
			}
			fallback := ""
			if cachedDiscovery {
				fallback = r.DefaultBranch
			}
			branch, err := previewBranchQuery(q.R.URL.RawQuery, fallback)
			if err != nil {
				return nil, err
			}
			var value string
			if cachedDiscovery {
				value, e = previews.PreviewReadme(q.ctx(), a, branch, refresh)
			} else {
				value, e = d.Readme(q.ctx(), a, branch)
			}
			if e != nil {
				return nil, e
			}
			return q.text(value), nil
		}
		var rows []provider.Branch
		if cachedDiscovery {
			rows, e = previews.PreviewBranches(q.ctx(), a, refresh)
		} else {
			rows, e = d.Branches(q.ctx(), a)
		}
		if e != nil {
			return nil, e
		}
		out := []M{}
		for _, branch := range rows {
			out = append(out, previewBranchJSON(branch))
		}
		return out, nil
	}
}

func (s *Server) authorizeContent(ctx context.Context, r M) (string, error) {
	return "", s.authorizeSource(ctx, r)
}
