//go:build linux

package blobcache

import (
	"errors"
	"math"
	"os"

	"golang.org/x/sys/unix"
)

func (c *Cache) diskSpace() (available uint64, unit int64, err error) {
	file, err := c.root.Open(".")
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()
	var stat unix.Statfs_t
	if err := unix.Fstatfs(int(file.Fd()), &stat); err != nil {
		return 0, 0, err
	}
	unit = int64(stat.Bsize)
	if unit <= 0 {
		return 0, 0, errors.New("invalid_cache_filesystem")
	}
	if stat.Bavail > math.MaxUint64/uint64(unit) {
		return math.MaxUint64, unit, nil
	}
	return stat.Bavail * uint64(unit), unit, nil
}

func allocatedBytes(file *os.File) (int64, error) {
	var stat unix.Stat_t
	if err := unix.Fstat(int(file.Fd()), &stat); err != nil {
		return 0, err
	}
	if stat.Blocks < 0 || stat.Blocks > math.MaxInt64/512 {
		return 0, errors.New("invalid_cache_allocation")
	}
	return max(4096, stat.Blocks*512), nil
}
