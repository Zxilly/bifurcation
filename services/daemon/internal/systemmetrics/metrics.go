package systemmetrics

import (
	"errors"
	"math"
	"strconv"
	"strings"
	"sync"
)

// Snapshot contains host counters, never user-attributed proxy traffic.
// Missing metrics remain nil instead of being reported as measured zeroes.
type Snapshot struct {
	CPUUsagePercent  *float64
	MemoryUsedBytes  *int64
	MemoryTotalBytes *int64
	DiskFreeBytes    *int64
	NetworkRXBytes   *int64
	NetworkTXBytes   *int64
	NetworkInterface string
}

type cpuCounters struct{ total, idle uint64 }
type Sampler struct {
	mu       sync.Mutex
	previous *cpuCounters
}

func New() *Sampler { return &Sampler{} }

func parseCPU(body string) (cpuCounters, error) {
	for line := range strings.SplitSeq(body, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[0] != "cpu" {
			continue
		}
		var result cpuCounters
		// guest and guest_nice are already included in user and nice.
		for index := 1; index < len(fields) && index <= 8; index++ {
			value, err := strconv.ParseUint(fields[index], 10, 64)
			if err != nil || value > math.MaxUint64-result.total {
				return result, errors.New("invalid CPU counters")
			}
			result.total += value
			if index == 4 || index == 5 {
				result.idle += value
			}
		}
		return result, nil
	}
	return cpuCounters{}, errors.New("CPU counters not found")
}

func (s *Sampler) cpuUsage(current cpuCounters) *float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous := s.previous
	s.previous = &current
	if previous == nil || current.total <= previous.total || current.idle < previous.idle {
		return nil
	}
	total, idle := current.total-previous.total, current.idle-previous.idle
	if idle > total {
		return nil
	}
	percent := 100 * float64(total-idle) / float64(total)
	return &percent
}

func parseMemory(body string) (*int64, *int64) {
	values := make(map[string]int64)
	for line := range strings.SplitSeq(body, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || (fields[0] != "MemTotal:" && fields[0] != "MemAvailable:") || fields[2] != "kB" {
			continue
		}
		value, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil || value < 0 || value > math.MaxInt64/1024 {
			return nil, nil
		}
		values[fields[0]] = value * 1024
	}
	total, hasTotal := values["MemTotal:"]
	available, hasAvailable := values["MemAvailable:"]
	if !hasTotal || !hasAvailable || total <= 0 || available > total {
		return nil, nil
	}
	used := total - available
	return &used, &total
}

func defaultInterface(ipv4, ipv6 string) string {
	selected := ""
	metric := uint64(math.MaxUint64)
	for line := range strings.SplitSeq(ipv4, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 8 || fields[0] == "lo" || fields[1] != "00000000" || fields[7] != "00000000" {
			continue
		}
		flags, flagErr := strconv.ParseUint(fields[3], 16, 64)
		priority, priorityErr := strconv.ParseUint(fields[6], 10, 64)
		if flagErr == nil && priorityErr == nil && flags&1 != 0 && priority < metric {
			selected, metric = fields[0], priority
		}
	}
	if selected != "" {
		return selected
	}
	for line := range strings.SplitSeq(ipv6, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 10 || fields[9] == "lo" || fields[0] != strings.Repeat("0", 32) || fields[1] != "00" {
			continue
		}
		flags, flagErr := strconv.ParseUint(fields[8], 16, 64)
		priority, priorityErr := strconv.ParseUint(fields[5], 16, 64)
		if flagErr == nil && priorityErr == nil && flags&1 != 0 && flags&0x200 == 0 && priority < metric {
			selected, metric = fields[9], priority
		}
	}
	return selected
}

func parseNetwork(body, device string) (*int64, *int64) {
	if device == "" || device == "lo" {
		return nil, nil
	}
	for line := range strings.SplitSeq(body, "\n") {
		name, counters, found := strings.Cut(line, ":")
		if !found || strings.TrimSpace(name) != device {
			continue
		}
		fields := strings.Fields(counters)
		if len(fields) < 9 {
			return nil, nil
		}
		rx, rxErr := strconv.ParseInt(fields[0], 10, 64)
		tx, txErr := strconv.ParseInt(fields[8], 10, 64)
		if rxErr != nil || txErr != nil || rx < 0 || tx < 0 {
			return nil, nil
		}
		return &rx, &tx
	}
	return nil, nil
}
