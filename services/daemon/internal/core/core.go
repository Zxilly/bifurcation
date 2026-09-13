package core

import (
	"context"
	"errors"
)

var ErrNotConfigured = errors.New("proxy core is not configured")
var ErrStalePolicy = errors.New("configuration authorization is stale")
var ErrUnsupported = errors.New("operation is not supported")

type Configuration struct {
	TaskID, RevisionID, SHA256 string
	PolicyRevision             int64
	JSON, Authorization        []byte
	LatestPolicyRevision       int64
}
type Health struct {
	Configured, Running, Healthy   bool
	Version, RuntimeID, RevisionID string
	PolicyRevision                 int64
	Issue                          string
	Connections                    *int64
	ConfigSHA256                   string
	StartedAt                      int64
}
type Counter struct {
	UserID, RuntimeID            string
	Upload, Download, ObservedAt int64
	StartedAt                    int64
	Final                        bool
}
type Result struct {
	Health   Health
	Rollback string
}
type LogResult struct {
	Source    string   `json:"source"`
	Lines     []string `json:"lines"`
	Truncated bool     `json:"truncated"`
}
type Adapter interface {
	Health(context.Context) (Health, error)
	Apply(context.Context, Configuration) (Result, error)
	Recover(context.Context) error
	Close(context.Context) error
	ReadCounters(context.Context) ([]Counter, error)
	ReadLogs(context.Context, int, int) (LogResult, error)
	SetFinalSample(func(context.Context, []Counter) error)
	AcknowledgeFinalSample(string)
}
