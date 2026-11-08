package storage

import (
	"context"
	"errors"
	"io/fs"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
)

type Entry struct {
	Path string
	Size int64
}

func (s *Store) List(ctx context.Context, repo string) ([]Entry, error) {
	prefix, e := key(repo, "")
	if e != nil {
		return nil, e
	}
	entries := []Entry{}
	add := func(name string, size int64) error {
		if _, e := security.RelativePath(name); e != nil {
			return e
		}
		if len(entries) >= 100000 {
			return errors.New("repository_too_large")
		}
		entries = append(entries, Entry{Path: name, Size: size})
		return nil
	}
	if s.root != nil {
		e = fs.WalkDir(s.root.FS(), strings.TrimSuffix(prefix, "/"), func(p string, d fs.DirEntry, err error) error {
			// Concurrent cleanup can remove an entry after ReadDir. Continue
			// walking so callers never mistake a partial list for a full snapshot.
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			if err != nil {
				return err
			}
			if e := ctx.Err(); e != nil {
				return e
			}
			if d.Type()&fs.ModeSymlink != 0 {
				return errors.New("storage_symlink_not_allowed")
			}
			if d.IsDir() {
				return nil
			}
			info, e := d.Info()
			if errors.Is(e, fs.ErrNotExist) {
				return nil
			}
			if e != nil {
				return e
			}
			if !info.Mode().IsRegular() {
				return errors.New("storage_file_not_regular")
			}
			return add(strings.TrimPrefix(p, prefix), info.Size())
		})
		return entries, e
	}
	pager := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{Bucket: aws.String(s.bucket), Prefix: aws.String(prefix)})
	for pager.HasMorePages() {
		page, e := pager.NextPage(ctx)
		if e != nil {
			return nil, e
		}
		for _, o := range page.Contents {
			if o.Key == nil || !strings.HasPrefix(*o.Key, prefix) || strings.HasSuffix(*o.Key, "/") {
				continue
			}
			if e = add(strings.TrimPrefix(*o.Key, prefix), aws.ToInt64(o.Size)); e != nil {
				return nil, e
			}
		}
	}
	return entries, nil
}
