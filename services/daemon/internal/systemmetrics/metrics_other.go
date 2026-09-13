//go:build !linux

package systemmetrics

func (s *Sampler) Read(string) Snapshot { return Snapshot{} }
