import { randomBytes } from "node:crypto";
import { test, expect, activate, passwordLogin, logout } from "./fixtures";
import { rpc } from "./rpc";

test("Passkey activation, login, recovery and password change use real authentication", async ({
  page,
  app,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const authenticator = await activate(page, app);
  const createdKey = await rpc<{ token: string }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.MeService/CreateApiKey",
    { name: "Recovery continuity" },
  );
  expect(createdKey.status).toBe(200);
  const { token: recoveryKey } = createdKey.body;
  await logout(page, app);
  await page
    .getByRole("button", { name: "使用 Passkey 登录", exact: true })
    .click();
  await expect(page).toHaveURL(`${app.origin}/admin`);
  await logout(page, app);
  await passwordLogin(page, app, randomBytes(24).toString("base64url"));
  await expect(
    page.getByText("用户名或密码不正确", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("后备密码", { exact: true }).fill(app.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/admin`);

  // Keep a second real session to prove account recovery revokes other devices.
  const otherContext = await page.context().browser()!.newContext();
  try {
    const otherPage = await otherContext.newPage();
    await passwordLogin(otherPage, app);
    await expect(otherPage).toHaveURL(`${app.origin}/admin`);
    await page.goto(`${app.origin}/admin/users`);
    const user = page.getByRole("row").filter({
      has: page.getByRole("cell", { name: app.username, exact: true }),
    });
    await user.getByRole("button", { name: "恢复账号", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "恢复账号", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "恢复链接", exact: true }),
    ).toBeVisible();
    const recoveryUrl = await page
      .getByRole("dialog")
      .locator("code")
      .innerText();
    // Model a lost local credential: the server still has the old Passkey until
    // successful recovery atomically replaces it with the newly registered one.
    await authenticator.cdp.send("WebAuthn.clearCredentials", {
      authenticatorId: authenticator.authenticatorId,
    });
    await page.goto(recoveryUrl);
    const recoveredPassword = randomBytes(24).toString("base64url");
    await page
      .getByLabel("Passkey 名称", { exact: true })
      .fill("Recovered authenticator");
    await page.getByLabel("后备密码", { exact: true }).fill(recoveredPassword);
    await page
      .getByLabel("确认后备密码", { exact: true })
      .fill(recoveredPassword);
    await page
      .getByRole("button", { name: "创建 Passkey 并恢复", exact: true })
      .click();
    await expect(page).toHaveURL(`${app.origin}/account`);
    await expect(
      page.getByRole("cell", { name: "Recovered authenticator", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", { name: "Test authenticator", exact: true }),
    ).toHaveCount(0);
    await otherPage.goto(`${app.origin}/account`);
    await expect(otherPage).toHaveURL(`${app.origin}/login`);
    const keyAfterRecovery = await rpc<{ authentication: string }>(
      page.request,
      app.origin,
      "bifurcation.panel.v1.MeService/GetMe",
      {},
      { Authorization: `Bearer ${recoveryKey}` },
    );
    expect(keyAfterRecovery.status).toBe(200);
    expect(keyAfterRecovery.body.authentication).toBe("AUTHENTICATION_API_KEY");

    const changedPassword = randomBytes(24).toString("base64url");
    await page
      .getByRole("button", { name: "修改后备密码", exact: true })
      .click();
    await page.getByLabel("新后备密码", { exact: true }).fill(changedPassword);
    await page.getByLabel("确认新密码", { exact: true }).fill(changedPassword);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "修改后备密码", exact: true })
      .click();
    await expect(page).toHaveURL(`${app.origin}/login`);
    await passwordLogin(page, app, changedPassword);
    await expect(page).toHaveURL(`${app.origin}/admin`);
  } finally {
    await otherContext.close();
  }
  expect(errors).toEqual([]);
});
