package systemmetrics

import (
	"math"
	"os"
	"syscall"
)

func (s *Sampler) Read(stateDirectory string) Snapshot {
	var snapshot Snapshot
	if body, err := os.ReadFile("/proc/stat"); err == nil {
		if counters, err := parseCPU(string(body)); err == nil {
			snapshot.CPUUsagePercent = s.cpuUsage(counters)
		}
	}
	if body, err := os.ReadFile("/proc/meminfo"); err == nil {
		snapshot.MemoryUsedBytes, snapshot.MemoryTotalBytes = parseMemory(string(body))
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(stateDirectory, &fs); err == nil && fs.Bsize > 0 && fs.Bavail <= uint64(math.MaxInt64)/uint64(fs.Bsize) {
		free := int64(fs.Bavail * uint64(fs.Bsize))
		snapshot.DiskFreeBytes = &free
	}
	ipv4, _ := os.ReadFile("/proc/net/route")
	ipv6, _ := os.ReadFile("/proc/net/ipv6_route")
	snapshot.NetworkInterface = defaultInterface(string(ipv4), string(ipv6))
	if body, err := os.ReadFile("/proc/net/dev"); err == nil {
		snapshot.NetworkRXBytes, snapshot.NetworkTXBytes = parseNetwork(string(body), snapshot.NetworkInterface)
	}
	return snapshot
}
