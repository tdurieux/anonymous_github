// Package storage provides atomic cache writes under a confined filesystem root
// or an S3 bucket. Repository content never determines an absolute path.
package storage

import (
	"context"
	"errors"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/tdurieux/anonymous_github/backend/internal/security"
	"io"
	"os"
	"path"
	"strings"
)

type Config struct{ Kind, Root, Bucket, Region, Endpoint, ID, Secret string }
type Store struct {
	root   *os.Root
	client *s3.Client
	bucket string
}

func New(c Config) (*Store, error) {
	if c.Kind == "s3" {
		if c.Bucket == "" || c.Region == "" || c.Endpoint == "" || c.ID == "" || c.Secret == "" {
			return nil, errors.New("s3_configuration_required")
		}
		client := s3.New(s3.Options{Region: c.Region, BaseEndpoint: aws.String(c.Endpoint), UsePathStyle: true, Credentials: credentials.NewStaticCredentialsProvider(c.ID, c.Secret, "")})
		return &Store{client: client, bucket: c.Bucket}, nil
	}
	if c.Kind != "" && c.Kind != "filesystem" {
		return nil, errors.New("invalid_storage")
	}
	if e := os.MkdirAll(c.Root, 0700); e != nil {
		return nil, e
	}
	root, e := os.OpenRoot(c.Root)
	return &Store{root: root}, e
}
func (s *Store) Close() {
	if s.root != nil {
		s.root.Close()
	}
}
func key(repo, p string) (string, error) {
	if strings.ContainsAny(repo, "/\\") {
		return "", errors.New("invalid_repository_id")
	}
	if _, e := security.RelativePath(repo); e != nil {
		return "", e
	}
	if p != "" {
		if _, e := security.RelativePath(p); e != nil {
			return "", e
		}
	}
	return repo + "/original/" + p, nil
}
func (s *Store) Read(ctx context.Context, repo, p string) (io.ReadCloser, error) {
	k, e := key(repo, p)
	if e != nil {
		return nil, e
	}
	if s.root != nil {
		return s.root.Open(k)
	}
	v, e := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(k)})
	if e != nil {
		return nil, e
	}
	return v.Body, nil
}

// Put checks the complete stream before publishing it. Neither oversized nor
// short upstream reads can replace an existing cache entry.
func (s *Store) Put(ctx context.Context, repo, p string, input io.Reader, expected, max int64) error {
	k, e := key(repo, p)
	if e != nil {
		return e
	}
	temp, e := os.CreateTemp("", "anonymous-cache-")
	if e != nil {
		return e
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	n, e := io.Copy(temp, io.LimitReader(input, max+1))
	if e != nil {
		return e
	}
	if n > max || n < expected {
		return errors.New("storage_write_size_mismatch")
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	if _, e = temp.Seek(0, 0); e != nil {
		return e
	}
	if s.root == nil {
		_, e = s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(k), Body: temp, ContentLength: aws.Int64(n)})
		return e
	}
	if e = s.root.MkdirAll(path.Dir(k), 0700); e != nil {
		return e
	}
	nonce, e := security.RandomToken()
	if e != nil {
		return e
	}
	tmp := k + ".tmp." + nonce
	out, e := s.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	defer s.root.Remove(tmp)
	_, e = io.Copy(out, temp)
	if e == nil {
		e = out.Sync()
	}
	closeErr := out.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	return s.root.Rename(tmp, k)
}
func (s *Store) Remove(ctx context.Context, repo, p string) error {
	k, e := key(repo, p)
	if e != nil {
		return e
	}
	k = strings.TrimSuffix(k, "/")
	if s.root != nil {
		return s.root.RemoveAll(k)
	}
	// Prefix includes a separator so deleting a cannot delete ab.
	exact, e := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(k)})
	_ = exact
	if e != nil {
		return e
	}
	pager := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{Bucket: aws.String(s.bucket), Prefix: aws.String(k + "/")})
	for pager.HasMorePages() {
		page, e := pager.NextPage(ctx)
		if e != nil {
			return e
		}
		objects := []types.ObjectIdentifier{}
		for _, o := range page.Contents {
			if o.Key != nil && strings.HasPrefix(*o.Key, k+"/") {
				objects = append(objects, types.ObjectIdentifier{Key: o.Key})
			}
		}
		if len(objects) > 0 {
			r, e := s.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{Bucket: aws.String(s.bucket), Delete: &types.Delete{Objects: objects}})
			if e != nil {
				return e
			}
			if len(r.Errors) > 0 {
				return errors.New("storage_delete_failed")
			}
		}
	}
	return nil
}

// Size returns the stored byte count without downloading the object.
func (s *Store) Size(ctx context.Context, repo, p string) (int64, error) {
	k, err := key(repo, p)
	if err != nil {
		return 0, err
	}
	if s.root != nil {
		info, err := s.root.Stat(k)
		if err != nil {
			return 0, err
		}
		if !info.Mode().IsRegular() {
			return 0, errors.New("folder_not_supported")
		}
		return info.Size(), nil
	}
	result, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(k)})
	if err != nil {
		var missing *types.NotFound
		if errors.As(err, &missing) {
			return 0, os.ErrNotExist
		}
		return 0, err
	}
	return aws.ToInt64(result.ContentLength), nil
}
