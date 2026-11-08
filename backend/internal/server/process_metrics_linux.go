//go:build linux

package server

import (
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

func processCPUSeconds() (float64, bool) {
	var usage unix.Rusage
	if unix.Getrusage(unix.RUSAGE_SELF, &usage) != nil {
		return 0, false
	}
	return float64(usage.Utime.Sec+usage.Stime.Sec) + float64(usage.Utime.Usec+usage.Stime.Usec)/1e6, true
}

func processSockets() any {
	dir, err := os.Open("/proc/self/fd")
	if err != nil {
		return nil
	}
	entries, err := dir.ReadDir(4096)
	dir.Close()
	if err != nil {
		return nil
	}
	inodes := map[string]bool{}
	for _, entry := range entries {
		link, err := os.Readlink("/proc/self/fd/" + entry.Name())
		if err == nil && strings.HasPrefix(link, "socket:[") && strings.HasSuffix(link, "]") {
			inodes[strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")] = true
		}
	}
	counts := map[string]int{}
	truncated := len(entries) == 4096
	for _, path := range []string{"/proc/self/net/tcp", "/proc/self/net/tcp6"} {
		data, err := boundedMetricFile(path, 4*1024*1024)
		if err != nil {
			return nil
		}
		truncated = truncated || len(data) == 4*1024*1024
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Fields(line)
			if len(fields) > 9 && inodes[fields[9]] {
				counts[fields[3]]++
			}
		}
	}
	return M{"descriptors": len(inodes), "established": counts["01"], "closeWait": counts["08"], "listening": counts["0A"], "truncated": truncated}
}
