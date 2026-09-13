package core

// Artifact describes the verified daemon executable used by the updater.
type Artifact struct {
	Version, URL, SHA256, OS, Arch string
	SizeBytes                      int64
}
