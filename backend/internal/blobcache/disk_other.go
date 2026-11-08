//go:build !linux

package blobcache

import "os"

// The shipped runtime is Linux. Reads remain portable; admission must not
// pretend physical disk accounting is available on an unsupported platform.
func (c *Cache) diskSpace() (uint64, int64, error) {
	return 0, 0, &AdmissionError{Code: "disk_accounting_not_supported"}
}
func allocatedBytes(*os.File) (int64, error) {
	return 0, &AdmissionError{Code: "disk_accounting_not_supported"}
}
