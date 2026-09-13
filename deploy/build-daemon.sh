#!/usr/bin/env bash
set -euo pipefail
version=${DAEMON_VERSION:-0.1.0}
case "$version" in ''|*[!A-Za-z0-9.+-]*) echo 'Invalid daemon version' >&2; exit 1 ;; esac
mkdir -p /artifacts
core_version=$(go list -m -f '{{.Version}}' github.com/sagernet/sing-box)
core_version=${core_version#v}
core_directory=$(go list -m -f '{{.Dir}}' github.com/sagernet/sing-box)
cp "$core_directory/LICENSE" /artifacts/LICENSE.sing-box
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -tags=with_quic -trimpath -buildvcs=false \
    -ldflags="-s -w -buildid= -X main.version=${version}" \
    -o "/artifacts/daemon-linux-${arch}" ./cmd/bifurcation-daemon
  (cd /artifacts && sha256sum "daemon-linux-${arch}" > "daemon-linux-${arch}.sha256")
done
go version -m /artifacts/daemon-linux-amd64 > /artifacts/daemon-build-info.txt
amd64_sha=$(sha256sum /artifacts/daemon-linux-amd64 | cut -d ' ' -f 1)
arm64_sha=$(sha256sum /artifacts/daemon-linux-arm64 | cut -d ' ' -f 1)
amd64_size=$(stat -c '%s' /artifacts/daemon-linux-amd64)
arm64_size=$(stat -c '%s' /artifacts/daemon-linux-arm64)
cat > /artifacts/daemon-manifest.json <<MANIFEST
{
  "version": "${version}",
  "bundledCoreVersion": "${core_version}",
  "protocolVersion": 1,
  "artifacts": {
    "amd64": {"filename": "daemon-linux-amd64", "sha256": "${amd64_sha}", "sizeBytes": ${amd64_size}},
    "arm64": {"filename": "daemon-linux-arm64", "sha256": "${arm64_sha}", "sizeBytes": ${arm64_size}}
  }
}
MANIFEST
