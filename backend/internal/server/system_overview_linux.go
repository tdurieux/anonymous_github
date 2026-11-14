//go:build linux

package server

import (
	"math"
	"os"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

func platformSystemOverview(out M) {
	var info unix.Sysinfo_t
	if unix.Sysinfo(&info) == nil {
		loads := []float64{float64(info.Loads[0]) / 65536, float64(info.Loads[1]) / 65536, float64(info.Loads[2]) / 65536}
		out["loadAvg"] = loads
		// Match the Node overview: normalized one-minute load, not CPU time.
		out["cpuPercent"] = math.Round(loads[0] / float64(runtime.NumCPU()) * 100)
		total, free := uint64(info.Totalram)*uint64(info.Unit), uint64(info.Freeram)*uint64(info.Unit)
		if total > 0 && free <= total {
			out["memTotal"], out["memFree"], out["memUsed"] = total, free, total-free
			out["memPercent"] = math.Round(float64(total-free) / float64(total) * 100)
		}
	}
	var disk unix.Statfs_t
	if unix.Statfs("/", &disk) == nil && disk.Bsize > 0 && disk.Blocks >= disk.Bfree {
		unit := uint64(disk.Bsize)
		total, used, available := disk.Blocks*unit, (disk.Blocks-disk.Bfree)*unit, disk.Bavail*unit
		out["diskTotal"], out["diskUsed"], out["diskFree"] = total, used, available
		out["diskPercent"] = float64(0)
		if total > 0 {
			out["diskPercent"] = math.Round(float64(used) / float64(total) * 100)
		}
	}
	if data, err := os.ReadFile("/proc/self/statm"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 1 {
			if pages, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
				out["processRss"] = pages * uint64(os.Getpagesize())
			}
		}
	}
}
