package singbox

import (
	"runtime/debug"
	"strings"
)

const pinnedVersion = "1.14.0"

func Version() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dependency := range info.Deps {
			if dependency.Path == "github.com/sagernet/sing-box" && dependency.Version != "" && dependency.Version != "(devel)" {
				return strings.TrimPrefix(dependency.Version, "v")
			}
		}
	}
	return pinnedVersion
}
