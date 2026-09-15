import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createArtifactFixture } from "./artifact-fixture";

const execFileAsync = promisify(execFile);
const fixtureRequire = createRequire(__filename);
const webRoot = resolve(__dirname, "..");

type TestApp = {
  origin: string;
  activationUrl: string;
  username: string;
  password: string;
  replaceDaemonArtifact: () => Promise<void>;
};

async function availablePort() {
  const reservation = createServer();
  await new Promise<void>((ready, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", ready);
  });
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("Cannot reserve E2E port");
  await new Promise<void>((done, reject) =>
    reservation.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

async function waitForServer(server: ChildProcess, origin: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error(`E2E server exited with ${server.exitCode}`);
    try {
      const response = await fetch(`${origin}/login`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      /* Server is still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("E2E server did not become ready; build the web app first");
}

async function stopServer(server: ChildProcess) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>((done) => server.once("exit", () => done()));
  server.kill();
  await exited;
}

export const test = base.extend<{ app: TestApp; initializeAdmin: boolean }>({
  initializeAdmin: [true, { option: true }],
  app: async ({ initializeAdmin }, provide) => {
    await Promise.all([
      access(join(webRoot, ".next", "BUILD_ID")),
      access(join(webRoot, "scripts", "admin.mjs")),
    ]).catch(() => {
      throw new Error(
        "Run pnpm --filter @bifurcation/web build before E2E tests",
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "bifurcation-e2e-"));
    let server: ChildProcess | undefined;
    try {
      const port = await availablePort();
      const origin = `http://localhost:${port}`;
      const username = `admin-${randomBytes(5).toString("hex")}`;
      const password = randomBytes(24).toString("base64url");
      const artifactDirectory = join(directory, "artifacts");
      const artifacts = await createArtifactFixture(artifactDirectory);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        BIFURCATION_PUBLIC_URL: origin,
        BIFURCATION_DATABASE_PATH: join(directory, "panel.sqlite"),
        BIFURCATION_APP_KEY: randomBytes(32).toString("hex"),
        BIFURCATION_ARTIFACT_DIRECTORY: artifactDirectory,
      };
      const { stdout } = initializeAdmin
        ? await execFileAsync(
            process.execPath,
            ["scripts/admin.mjs", "init", username],
            { cwd: webRoot, env, encoding: "utf8" },
          )
        : { stdout: `${origin}/setup` };
      const activationUrl = stdout.trim();
      const activation = new URL(activationUrl);
      if (
        initializeAdmin &&
        (activation.origin !== origin ||
          activation.pathname !== "/activate" ||
          !activation.searchParams.has("token"))
      )
        throw new Error("Admin initializer did not return an activation URL");
      server = spawn(
        process.execPath,
        [
          fixtureRequire.resolve("next/dist/bin/next"),
          "start",
          "--port",
          String(port),
          "--hostname",
          "127.0.0.1",
        ],
        { cwd: webRoot, env, stdio: "ignore", windowsHide: true },
      );
      await waitForServer(server, origin);
      await provide({
        origin,
        activationUrl,
        username,
        password,
        replaceDaemonArtifact: artifacts.replaceDaemonArtifact,
      });
    } finally {
      if (server) await stopServer(server);
      const resolved = resolve(directory);
      if (
        dirname(resolved) !== resolve(tmpdir()) ||
        !basename(resolved).startsWith("bifurcation-e2e-")
      )
        throw new Error(
          "Refusing to remove a directory outside the E2E fixture root",
        );
      await rm(resolved, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
});

export { expect };

/** The full text rendered by a CopyValue inside `scope` (the display is CSS-truncated only). */
export function copyValueText(scope: Locator | Page): Locator {
  return scope
    .getByRole("button", { name: "复制", exact: true })
    .locator("xpath=preceding-sibling::span[1]");
}

export async function activate(page: Page, app: TestApp) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  await page.goto(app.activationUrl);
  await page
    .getByRole("button", { name: "添加 Passkey（可选）", exact: true })
    .click();
  await page
    .getByLabel("Passkey 名称", { exact: true })
    .fill("Test authenticator");
  await page.getByLabel("后备密码", { exact: true }).fill(app.password);
  await page.getByLabel("确认后备密码", { exact: true }).fill(app.password);
  await page
    .getByRole("button", { name: "创建 Passkey 并激活", exact: true })
    .click();
  await expect(page).toHaveURL(`${app.origin}/account`);
  await expect(
    page.getByRole("cell", { name: "Test authenticator", exact: true }),
  ).toBeVisible();
  return { cdp, authenticatorId };
}

export async function passwordLogin(
  page: Page,
  app: TestApp,
  password = app.password,
) {
  await page.goto(`${app.origin}/login`);
  await page.getByRole("button", { name: "使用后备密码", exact: true }).click();
  await page.getByLabel("用户名", { exact: true }).fill(app.username);
  await page.getByLabel("后备密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

export async function logout(page: Page, app: TestApp) {
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/login`);
}
