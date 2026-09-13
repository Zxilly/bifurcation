# Bifurcation daemon

The daemon subscribes to panel tasks over Connect RPC and embeds
`github.com/sagernet/sing-box v1.14.0` for Trojan and Hysteria2 proxy traffic.
`APPLY_CONFIG` initializes or replaces the in-process core. Core code ships and
upgrades with the daemon. Restarting or upgrading the daemon can interrupt proxy
connections.

See [Development](../../docs/DEVELOPMENT.md) for repository setup, generated code
and project-wide validation, and [third-party notices](../../THIRD_PARTY_NOTICES.md)
for dependency licenses.

## Run

Build with QUIC and ACME support:

```sh
go build -tags=with_quic,with_acme -ldflags '-X main.version=0.1.0' ./cmd/bifurcation-daemon
```

The private configuration file contains:

```json
{
  "panelUrl": "https://panel.example.com",
  "token": "administrator-provided-machine-token",
  "stateDirectory": "/var/lib/bifurcation"
}
```

Run `bifurcation-daemon -config /etc/bifurcation/daemon.json`. On startup, the
approved configuration is restored before local readiness is reported. A fresh
installation remains unconfigured until its first `APPLY_CONFIG` task. Inspect
logs are available in either state as `{source:"embedded-core",lines:[],truncated:false}`.

Installation and maintenance are owned by the repository deployment scripts.
Machine credentials remain in the configuration file; they are not passed in
subprocess arguments or included in diagnostic output.

## Core and accounting

The adapter decodes options with the library's typed registries and calls
`box.New`, `Start` and `Close` directly. Only Trojan and Hysteria2 managed user
lists are replaced by the authorization layer. The original approved JSON bytes
and their digest are retained. Recovery and failed updates merge the previous
base with the latest durable authorization floor before starting it again.

The router tracker attributes traffic by `metadata.User`, using stable user IDs.
TCP and UDP reads count upload; writes count download. Neither whole-interface
traffic nor a management RPC is used for user accounting. Resource metrics are
sampled independently from the host.

Before a new instance starts listening, its zero counters and dirty runtime
marker are persisted. A managed runtime's first nonzero sample is counted from
its known start time. Normal closure performs `Box.Close`, tracker `Drain`, then
a final sample and atomically records the closed marker. A process crash without
that marker produces an explicit unknown-tail gap on the next runtime. Final
snapshots whose persistence temporarily fails remain available for retry.

Ent owns task journals, applied/pending core configuration, counters and the
immutable protobuf usage outbox. Counters and numbered batches commit in the
same SQLite transaction. Long samples are split into bounded intervals and
batches without losing integer bytes. The 64 MiB outbox budget provides
backpressure; only committed ACKs remove data. A panel high-water rollback
requires recovery and never causes fabricated data or silent deletion.

Database migrations are reviewed SQL generated from the Ent schema. The migration
ledger verifies their checksums, and automatic upgrade rollback requires a matching
schema fingerprint.

## Validate

```sh
go generate ./internal/state
go test -tags=with_quic,with_acme ./...
go vet -tags=with_quic,with_acme ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags=with_quic,with_acme ./cmd/bifurcation-daemon
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -tags=with_quic,with_acme ./cmd/bifurcation-daemon
```

`TestEmbeddedTCPUDPAndFinalAccounting` uses actual embedded server and client
instances, real TLS, TCP echo and UDP echo for two users and both protocols.
`TestEmbeddedStartupFailureRollsBackLatestAuthorization` occupies a real port to
exercise startup failure and safe rollback. The tracker tests separately cover
partial I/O, closure races and packet headroom behavior. Tests using actual
systemd maintenance still require an explicitly disposable Linux container.
