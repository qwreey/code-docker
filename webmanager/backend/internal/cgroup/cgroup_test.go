package cgroup

import "testing"

func TestParseMemoryStat(t *testing.T) {
	m, ok := parseMemoryStat("anon 254959616\nfile 7348224\nkernel 9633792\nshmem 4096\nfile_mapped 28672\ninactive_file 7335936\nactive_file 28672\n")
	if !ok || m.AnonBytes != 254959616 || m.FileBytes != 7348224 || m.ShmemBytes != 4096 || m.InactiveFileBytes != 7335936 {
		t.Fatalf("parseMemoryStat = %+v, %v", m, ok)
	}
	if got := m.WorkingSet(280043520); got != 280043520-7335936 {
		t.Fatalf("WorkingSet = %d", got)
	}
	if got := (MemoryStat{InactiveFileBytes: 10}).WorkingSet(5); got != 0 {
		t.Fatalf("WorkingSet below zero = %d, want 0", got)
	}
	if _, ok := parseMemoryStat("garbage\n"); ok {
		t.Fatal("parseMemoryStat accepted a file with none of the keys")
	}
}
