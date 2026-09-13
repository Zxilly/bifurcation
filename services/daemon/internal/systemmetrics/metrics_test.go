package systemmetrics

import "testing"

func TestCPUExcludesGuestAndHandlesReset(t *testing.T) {
	before, err := parseCPU("cpu 100 0 50 800 10 0 0 0 40 0\ncpu0 1 0 1 1 0\n")
	if err != nil || before.total != 960 || before.idle != 810 {
		t.Fatalf("before=%+v err=%v", before, err)
	}
	after, err := parseCPU("cpu 120 0 60 860 20 0 0 0 50 0\n")
	if err != nil {
		t.Fatal(err)
	}
	sampler := New()
	if sampler.cpuUsage(before) != nil {
		t.Fatal("first observation must not claim a measured percentage")
	}
	if percent := sampler.cpuUsage(after); percent == nil || *percent != 30 {
		t.Fatalf("wanted 30%% utilization, got %v", percent)
	}
	if sampler.cpuUsage(cpuCounters{total: 1, idle: 1}) != nil {
		t.Fatal("counter reset must remain unknown")
	}
}

func TestMemoryUsesAvailableAndNetworkUsesDefaultRoute(t *testing.T) {
	used, total := parseMemory("MemTotal: 1024 kB\nMemFree: 100 kB\nMemAvailable: 256 kB\n")
	if used == nil || total == nil || *used != 768*1024 || *total != 1024*1024 {
		t.Fatalf("unexpected memory: %v/%v", used, total)
	}
	if used, _ = parseMemory("MemTotal: 1024 kB\n"); used != nil {
		t.Fatal("missing available memory must remain unknown")
	}
	routes := "Iface Destination Gateway Flags RefCnt Use Metric Mask\neth1 00000000 0100000A 0003 0 0 200 00000000\neth0 00000000 0100000A 0003 0 0 100 00000000\n"
	device := defaultInterface(routes, "")
	if device != "eth0" {
		t.Fatalf("wrong default interface: %q", device)
	}
	rx, tx := parseNetwork("lo: 9999 0 0 0 0 0 0 0 9999\neth0: 123 1 0 0 0 0 0 0 456 1 0 0 0 0 0 0\neth1: 8888 0 0 0 0 0 0 0 8888\n", device)
	if rx == nil || tx == nil || *rx != 123 || *tx != 456 {
		t.Fatalf("wrong interface counters: %v/%v", rx, tx)
	}
}
