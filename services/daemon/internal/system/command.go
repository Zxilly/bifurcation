package system

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"unicode/utf8"
)

// limitedBuffer keeps diagnostics bounded while continuing to drain the child.
type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < b.limit {
		_, _ = b.Buffer.Write(p[:min(len(p), b.limit-b.Len())])
	}
	return n, nil
}
func Command(ctx context.Context, path string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	output := &limitedBuffer{limit: 256 << 10}
	cmd.Stdout = output
	cmd.Stderr = output
	err := cmd.Run()
	if err != nil {
		return output.String(), fmt.Errorf("%s failed: %w: %s", path, err, strings.TrimSpace(output.String()))
	}
	return output.String(), nil
}

func LimitString(value string, limit int) string {
	value = strings.ToValidUTF8(value, "�")
	if len(value) <= limit {
		return value
	}
	value = value[:limit]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}
