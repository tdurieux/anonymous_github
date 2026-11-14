package server

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/tdurieux/anonymous_github/backend/internal/anonymize"
	"github.com/tdurieux/anonymous_github/backend/internal/provider"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

type archiveInput struct {
	row  M
	file *os.File // nil means the provider requires the normal file path
	err  error
}

func (i archiveInput) close() {
	if i.file != nil {
		i.file.Close()
		os.Remove(i.file.Name())
	}
}

type archiveOutput struct {
	name    string
	reader  io.Reader
	cleanup func()
	err     error
}

// The two unbuffered handoffs bound the work to one downloading input, one
// transforming entry and one output being compressed. Slow clients backpressure
// both stages. No repository-sized spool or unbounded worker queue is created.
func (s *Server) zipFromArchive(q *request, r M, p provider.Repositories, access provider.Access, capability provider.Archives) (any, error) {
	engine, err := s.engine(r, "repo")
	if err != nil {
		return nil, err
	}
	if _, err = s.authorizeContent(q.ctx(), r); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(q.ctx())
	defer cancel()
	source, err := capability.OpenArchive(ctx, access)
	if err != nil {
		return nil, err
	}
	inputs := make(chan archiveInput)
	outputs := make(chan archiveOutput)
	producerDone, transformDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(producerDone)
		defer close(inputs)
		defer source.Close()
		err := s.readArchiveInputs(ctx, r, p, access, source, inputs)
		if err != nil {
			select {
			case inputs <- archiveInput{err: err}:
			case <-ctx.Done():
			}
		}
	}()
	go func() {
		defer close(transformDone)
		defer close(outputs)
		// Drain and remove any input already prepared when output/transform fails.
		defer func() {
			cancel()
			for input := range inputs {
				input.close()
			}
		}()
		seen := map[string]bool{}
		for input := range inputs {
			output := archiveOutput{err: input.err}
			if output.err == nil {
				original := path.Join(str(input.row["path"]), str(input.row["name"]))
				output.name, output.err = engine.Path(ctx, original)
				if output.err == nil {
					safe, e := security.RelativePath(output.name)
					if e != nil || safe != output.name || seen[output.name] {
						output.err = errors.New("invalid_or_duplicate_archive_path")
					}
					seen[output.name] = true
				}
				if output.err == nil {
					if input.file == nil {
						output.reader, output.cleanup, _, output.err = s.transformed(ctx, r, input.row)
					} else {
						output.reader, output.cleanup, _, output.err = s.transformBody(ctx, r, input.row, io.NopCloser(input.file))
					}
				}
			}
			input.close()
			select {
			case outputs <- output:
			case <-ctx.Done():
				if output.cleanup != nil {
					output.cleanup()
				}
				return
			}
			if output.err != nil {
				return
			}
		}
	}()
	// Wait for both stages on every exit, including http.ErrAbortHandler panic.
	defer func() { cancel(); <-transformDone; <-producerDone }()
	q.W.Header().Set("Content-Disposition", downloadDisposition(str(r["repoId"])+".zip"))
	q.W.Header().Set("Content-Type", "application/zip")
	q.W.Header().Set("Cache-Control", "private, no-cache")
	q.W.Header().Set("X-Accel-Buffering", "no")
	archive := newStreamZIP(q.W)
	for output := range outputs {
		if output.err != nil {
			s.recordZIPFailure(q.ctx(), "prepare", output.err)
			panic(http.ErrAbortHandler)
		}
		// Preparation can overlap an earlier entry's download. Recheck the live
		// grant and revision at release, after every wait, before emitting bytes.
		stage := "authorization"
		err := s.activeContentCache(q.ctx(), r)
		if err == nil {
			_, err = s.authorizeContent(q.ctx(), r)
		}
		if err == nil {
			stage = "output"
			err = archive.add(q.ctx(), output.name, output.reader)
		}
		output.cleanup()
		if err != nil {
			s.recordZIPFailure(q.ctx(), stage, err)
			panic(http.ErrAbortHandler)
		}
	}
	if err := q.ctx().Err(); err != nil {
		s.recordZIPFailure(q.ctx(), "finalize", err)
		panic(http.ErrAbortHandler)
	}
	if err := archive.archive.Close(); err != nil {
		s.recordZIPFailure(q.ctx(), "finalize", err)
		panic(http.ErrAbortHandler)
	}
	return written{}, nil
}

func (s *Server) readArchiveInputs(ctx context.Context, r M, p provider.Repositories, access provider.Access, source provider.Archive, out chan<- archiveInput) error {
	seen := map[string]bool{}
	copyBuffer := make([]byte, 32<<10)
	send := func(input archiveInput) error {
		select {
		case out <- input:
			return nil
		case <-ctx.Done():
			input.close()
			return ctx.Err()
		}
	}
	for {
		entry, body, err := source.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		relative, err := security.RelativePath(entry.Path)
		if err != nil || relative != entry.Path || seen[relative] || entry.Directory {
			return errors.New("invalid_or_duplicate_archive_path")
		}
		seen[relative] = true
		dir, name := path.Split(relative)
		dir = strings.TrimSuffix(dir, "/")
		if name == ".gitmodules" {
			continue
		}
		if !fileAllowed(name, obj(r["options"])) {
			continue
		}
		if err := s.activeContentCache(ctx, r); err != nil {
			return err
		}
		rows, err := s.Store.list(ctx, "files", M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r), "path": dir, "name": name}, 2, nil)
		if err != nil {
			return err
		}
		if len(rows) > 1 {
			return errors.New("duplicate_archive_metadata")
		}
		var row M
		if len(rows) == 1 {
			row = rows[0]
		}
		if row == nil || row["size"] == nil {
			// Truncated trees can omit metadata. Resolve through the provider at the
			// same immutable commit; never trust an unbound archive-only path.
			metadata, ok := p.(provider.FileMetadata)
			if !ok {
				return errors.New("archive_metadata_missing")
			}
			resolved, err := metadata.FileMetadata(ctx, access, relative)
			if err != nil {
				return err
			}
			if resolved == nil || resolved.Directory || resolved.Path != relative {
				return errors.New("archive_metadata_missing")
			}
			row = M{"path": dir, "name": name, "size": resolved.Size, "sha": resolved.Revision}
		}
		input, err := spoolArchiveInput(ctx, body, entry.Size, row, p, access, copyBuffer)
		if err != nil {
			return err
		}
		if err = send(input); err != nil {
			return err
		}
	}
	// Git export-ignore can omit tracked blobs. Retrieve only those exceptional
	// entries via the regular provider path, preserving the existing ZIP output.
	rows, err := s.Store.DB.Collection("files").Find(ctx, M{"repoId": r["repoId"], "treeGeneration": activeGeneration(r), "size": M{"$ne": nil}}, options.Find().SetBatchSize(128).SetProjection(M{"path": 1, "name": 1, "sha": 1, "size": 1, "upstream": 1, "submodule": 1}))
	if err != nil {
		return err
	}
	defer rows.Close(ctx)
	for rows.Next(ctx) {
		var row M
		if err := rows.Decode(&row); err != nil {
			return err
		}
		if seen[path.Join(str(row["path"]), str(row["name"]))] || !fileAllowed(str(row["name"]), obj(r["options"])) {
			continue
		}
		if err = send(archiveInput{row: row}); err != nil {
			return err
		}
	}
	return rows.Err()
}

func spoolArchiveInput(ctx context.Context, body io.Reader, size int64, row M, p provider.Repositories, access provider.Access, copyBuffer []byte) (archiveInput, error) {
	if size < 0 || size > anonymize.MaxInput {
		return archiveInput{}, fail("file_too_big", 413)
	}
	file, err := os.CreateTemp("", "anonymous-go-archive-")
	if err != nil {
		return archiveInput{}, err
	}
	input := archiveInput{row: row, file: file}
	ok := false
	defer func() {
		if !ok {
			input.close()
		}
	}()
	gitHash, digest := sha1.New(), sha256.New()
	fmt.Fprintf(gitHash, "blob %d\x00", size)
	n, err := io.CopyBuffer(io.MultiWriter(file, gitHash, digest), &zipContextReader{ctx: ctx, reader: io.LimitReader(body, size+1)}, copyBuffer)
	if err != nil {
		return archiveInput{}, err
	}
	if n != size {
		return archiveInput{}, errors.New("archive_entry_size_mismatch")
	}
	if _, err = file.Seek(0, 0); err != nil {
		return archiveInput{}, err
	}
	prefix := make([]byte, 256)
	count, err := file.Read(prefix)
	if err != nil && err != io.EOF {
		return archiveInput{}, err
	}
	err = nil // An empty file has a valid empty prefix.
	entry := fileProviderEntry(row)
	proof := provider.ContentProof{GitSHA: hex.EncodeToString(gitHash.Sum(nil)), SHA256: hex.EncodeToString(digest.Sum(nil)), Size: n}
	if verifier, exists := p.(provider.ArchiveContentVerifier); exists {
		err = verifier.VerifyArchiveContent(ctx, access, entry, proof, prefix[:count])
	} else if verifier, exists := p.(provider.ContentVerifier); exists {
		_, err = verifier.VerifyContent(ctx, access, entry, proof)
	} else if size != entry.Size {
		err = errors.New("archive_entry_size_mismatch")
	}
	if errors.Is(err, provider.ErrArchiveEntryFallback) {
		return archiveInput{row: row}, nil
	}
	if err != nil {
		return archiveInput{}, err
	}
	if _, err = file.Seek(0, 0); err != nil {
		return archiveInput{}, err
	}
	ok = true
	return input, nil
}
