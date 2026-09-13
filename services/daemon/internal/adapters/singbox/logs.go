package singbox

import (
	"github.com/Zxilly/bifurcation/services/daemon/internal/core"
	"github.com/sagernet/sing-box/log"
	"strings"
	"sync"
)

type logBuffer struct {
	mu      sync.Mutex
	lines   []string
	size    int
	dropped bool
}

func (b *logBuffer) append(message string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	message = strings.TrimRight(message, "\r\n")
	if len(message) > 256<<10 {
		message = message[len(message)-(256<<10):]
		b.dropped = true
	}
	b.lines = append(b.lines, message)
	b.size += len(message)
	for b.size > 1<<20 || len(b.lines) > 5000 {
		b.size -= len(b.lines[0])
		b.lines = b.lines[1:]
		b.dropped = true
	}
}
func (b *logBuffer) read(maxLines, maxBytes int) core.LogResult {
	b.mu.Lock()
	defer b.mu.Unlock()
	maxLines = max(1, min(5000, maxLines))
	maxBytes = max(1, min(256<<10, maxBytes))
	result := core.LogResult{Source: "embedded-core", Lines: []string{}, Truncated: b.dropped}
	start := max(0, len(b.lines)-maxLines)
	if start > 0 {
		result.Truncated = true
	}
	size := 0
	for i := len(b.lines) - 1; i >= start; i-- {
		if size+len(b.lines[i]) > maxBytes {
			result.Truncated = true
			break
		}
		result.Lines = append(result.Lines, b.lines[i])
		size += len(b.lines[i])
	}
	for i, j := 0, len(result.Lines)-1; i < j; i, j = i+1, j-1 {
		result.Lines[i], result.Lines[j] = result.Lines[j], result.Lines[i]
	}
	return result
}

type instanceLogWriter struct {
	buffer *logBuffer
	level  log.Level
}

func (w instanceLogWriter) WriteMessage(level log.Level, message string) {
	if level <= w.level {
		w.buffer.append(message)
	}
}
