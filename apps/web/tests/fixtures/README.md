# Public TLS test fixtures

`test-server-cert.pem` and `test-server-key.pem` are a matching, public test pair for `node.test`, `node-a`, `node-b`, and loopback. They exercise certificate validation and configuration rendering in `proxy.test.ts`. They are not production credentials and must not be used outside disposable tests.

The repository's PEM ignore rule excludes real credentials; only these two exact fixture paths are exempted.
