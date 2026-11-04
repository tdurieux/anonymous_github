package storage

import (
	"context"
	"errors"
	"os"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

// RemoveFiles deletes only the supplied object names, never their descendants.
// Validate the entire request before deleting anything. Missing files are safe
// to retry; filesystem directories are deliberately not removed recursively.
func (s *Store) RemoveFiles(ctx context.Context, repo string, paths []string) error {
	keys := make([]string, len(paths))
	for i, p := range paths {
		if p == "" {
			return errors.New("invalid_file_path")
		}
		k, err := key(repo, p)
		if err != nil {
			return err
		}
		keys[i] = k
	}
	for len(keys) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		if s.root != nil {
			if err := s.root.Remove(keys[0]); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			keys = keys[1:]
			continue
		}
		n := min(len(keys), 1000)
		objects := make([]types.ObjectIdentifier, n)
		for i, k := range keys[:n] {
			objects[i].Key = aws.String(k)
		}
		result, err := s.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{Bucket: aws.String(s.bucket), Delete: &types.Delete{Objects: objects}})
		if err != nil {
			return err
		}
		if len(result.Errors) > 0 {
			return errors.New("storage_delete_failed")
		}
		keys = keys[n:]
	}
	return nil
}
