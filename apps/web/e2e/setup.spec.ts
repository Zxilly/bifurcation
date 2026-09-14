import { test, expect, logout, passwordLogin } from "./fixtures";
import { rpc } from "./rpc";

test.use({ initializeAdmin: false });

test("first visit creates an administrator without CLI initialization and closes setup", async ({ page, app }) => {
  await page.goto(app.origin);
  await expect(page).toHaveURL(`${app.origin}/setup`);
  await expect(page.getByRole("heading", { name: "创建管理员", exact: true })).toBeVisible();
  await page.goto(`${app.origin}/login`);
  await expect(page).toHaveURL(`${app.origin}/setup`);
  const input = { username: app.username, password: "1" };
  const wrongOrigin = await rpc(page.request, app.origin, "bifurcation.panel.v1.AuthService/SetupAdministrator", input, { Origin: "https://wrong.example" });
  expect(wrongOrigin.status).toBe(403);
  await page.getByLabel("用户名", { exact: true }).fill(app.username);
  await page.getByLabel("后备密码", { exact: true }).fill("1");
  await page.getByLabel("确认后备密码", { exact: true }).fill("2");
  await page.getByRole("button", { name: "创建管理员并进入", exact: true }).click();
  await expect(page.getByText("两次输入的密码不一致。", { exact: true })).toBeVisible();
  await page.getByLabel("确认后备密码", { exact: true }).fill("1");
  await page.getByRole("button", { name: "创建管理员并进入", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/admin`);
  await page.goto(`${app.origin}/setup`);
  await expect(page).toHaveURL(`${app.origin}/admin`);
  await logout(page, app);
  await page.goto(`${app.origin}/setup`);
  await expect(page).toHaveURL(`${app.origin}/login`);
  const replay = await rpc(page.request, app.origin, "bifurcation.panel.v1.AuthService/SetupAdministrator", { username: "intruder", password: "2" });
  expect(replay.status).toBe(400);
  await passwordLogin(page, app, "1");
  await expect(page).toHaveURL(`${app.origin}/admin`);
});
