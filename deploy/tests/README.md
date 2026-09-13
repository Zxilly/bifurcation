# Deployment and transport regression tests

These tests create disposable resources. Never point their service fixtures at an existing server or production database. sing-box is embedded into the daemon; no separate core binary or core systemd service is installed.

## Panel image

```sh
docker build -t bifurcation:ci .
node deploy/tests/panel.test.mjs bifurcation:ci
```

The panel test starts a uniquely named container and volume, verifies health and SSR, runs the real administrator CLI, recreates the container, checks persistence, and cleans up. Image construction checks the exact Turbopack native-module aliases used by instrumentation. The daemon manifest records both its version and the embedded sing-box module version.

## Backup and restore

Run the Linux restore regression against the same image:

```sh
docker run --rm --network none --entrypoint node \
  -e BIFURCATION_DISPOSABLE_TEST_CONTAINER=1 \
  -v "$PWD/deploy/tests:/tests:ro" \
  bifurcation:ci /tests/backup-restore.test.mjs
```

It checks the live database lock, committed WAL preservation, atomic replacement, incorrect keys and corrupt-file preservation. All writes are confined to the disposable container.

## Installer

Extract `/app/artifacts/daemon-linux-amd64` from the built image to `daemon-test`, then run:

```sh
docker run --rm --network none \
  -e BIFURCATION_DISPOSABLE_TEST_CONTAINER=1 \
  -v "$PWD/deploy:/source:ro" -v "$PWD/daemon-test:/fixtures/daemon:ro" \
  ubuntu:22.04 sh /source/tests/install.test.sh
```

This tests shell failure handling, checksum rejection, configuration conflicts and preservation using the real daemon. Only downloads and systemctl are replaced. Existing unrelated sing-box files must remain untouched.

## Embedded core and systemd maintenance

Build Linux amd64 fixtures from `services/daemon` with `CGO_ENABLED=0`:

```sh
go build -tags=with_quic,with_acme -ldflags='-X main.version=0.0.0-dev' -o /tmp/bif-fixtures/old ./cmd/bifurcation-daemon
go build -tags=with_quic,with_acme -ldflags='-X main.version=0.1.0' -o /tmp/bif-fixtures/new ./cmd/bifurcation-daemon
go build -o /tmp/bif-fixtures/bad ./internal/updater/testdata/bad_start
go test -tags=with_quic,with_acme -c -o /tmp/bif-fixtures/maintenance.test ./internal/updater
go test -tags=with_quic,with_acme -c -o /tmp/bif-fixtures/core.test ./internal/adapters/singbox
```

```sh
docker build -t bif-systemd-test deploy/tests/systemd
docker run -d --name bif-systemd-ci --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock -v /tmp/bif-fixtures:/fixtures:ro bif-systemd-test
docker exec bif-systemd-ci /fixtures/core.test -test.v
docker exec -e BIFURCATION_DISPOSABLE_SYSTEMD_TEST=1 \
  -e BIFURCATION_TEST_OLD=/fixtures/old -e BIFURCATION_TEST_NEW=/fixtures/new \
  -e BIFURCATION_TEST_BAD=/fixtures/bad \
  bif-systemd-ci /fixtures/maintenance.test -test.v
docker rm -f bif-systemd-ci
```

The maintenance suite requires an explicit test flag and Docker container marker before manipulating service units. Startup failures, local health, unavailable control plane and lost acknowledgements are separate failure seams. Updating the daemon restarts its embedded core and interrupts existing proxy connections; normal stop closes the instance and settles in-flight I/O before persisting final counters. Crash recovery cannot reconstruct unobserved memory counters.

Schema definitions and reviewed SQL must remain synchronized. Schema changes require a migration and rollback policy for deployed databases.

## TCP and UDP attribution

`traffic/main.go` is a standard-library integration helper. Build it as a single Go source file for Linux, run `traffic serve` on an isolated origin, and use `traffic tcp SOCKS_ADDRESS ORIGIN_IP:8080` and `traffic udp SOCKS_ADDRESS ORIGIN_IP:9090` through a client sing-box mixed inbound. TCP is verified byte-for-byte; UDP uses SOCKS5 UDP association and validates ten echoed datagrams. A client CLI used by a test is not a production core service.

The automated embedded-engine regression is TestEmbeddedTCPUDPAndFinalAccounting in services/daemon/internal/adapters/singbox. Use this helper for additional manual network checks. Credentials and generated client configurations must remain outside version control.
