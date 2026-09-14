# Browser regression tests

Run from a built checkout:

```sh
pnpm --filter @bifurcation/web build
pnpm --filter @bifurcation/web exec playwright install chromium
pnpm --filter @bifurcation/web exec playwright test
```

Linux CI can use `playwright install --with-deps chromium`. On Windows, an installed Microsoft Edge can be used by setting `BIFURCATION_E2E_CHANNEL=msedge` before running the tests. Chromium's virtual WebAuthn authenticator performs actual browser credential registration and authentication against the application; no authentication API is mocked.

Each test independently creates an operating-system temporary directory, a SQLite database, random application key and administrator credentials. It invokes the production `scripts/admin.mjs init` command, then starts the already-built Next.js application on an available local port. It never reuses a running development server or a developer's database. Fixture teardown terminates only its own child process, verifies the temporary directory boundary and removes the database and related files. Do not run another web build while these tests are running.

The tests cover activation, Passkey and password login, wrong-password errors, account recovery and session revocation, password-change logout, one-time API Key display and real API authentication, user and machine creation, persistent machine Token display, pending-machine operation gating, mobile navigation and 390 px overflow.

Kumo regressions cover select labels and form submission, dialog typography, manual copying after clipboard denial, and mobile navigation dismissal, focus restoration and route changes. Configuration tests also verify the usage chart and expanded table stay within the mobile viewport.

Account recovery invalidates old login credentials and sessions while preserving long-lived API Keys. The identity test verifies the old Key still authenticates after recovery; revoking a Key remains an explicit account operation.

Configuration and usage tests connect a protocol peer to the real Connect endpoints, publish a configuration through the browser, report a deterministic task result and byte counters, and verify accounting replay protection, independent subscription/credential resets and the rendered ECharts view. This exercises the panel's actual database and API path without introducing test endpoints. The peer does not start the embedded sing-box engine; in-process traffic accounting and actual daemon restarts remain separate Go integration checks.

Upgrade tests generate only daemon manifests and inert daemon payloads, including the version of the embedded sing-box library. They verify that there is no independent core upgrade action, that daemon restart warns of interrupted proxy connections, and that SHA drift requires renewed confirmation. They also cover reported daemon rollback, updater handoff and reconnection, removal of progress after a terminal result, and unified daemon/embedded-core uninstall followed by a separate removal of the panel record. Management tests exercise editing metadata and replacing an installation with a new Token and an empty binding. These fixtures validate the control-plane contract; they are not executable release artifacts or proof of a systemd upgrade.

Screenshots, videos and traces are disabled because the tested pages display credentials. Keep Playwright `test-results/` out of version control. No fixtures or credentials are committed, and the tests do not introduce any application test endpoints.
