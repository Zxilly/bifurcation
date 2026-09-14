import { test, expect, activate } from "./fixtures";
import { rpc } from "./rpc";

test("overview retains its last successful snapshot during failed polling and retries", async ({
  page,
  app,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await activate(page, app);
  await page.goto(`${app.origin}/admin`);
  const enabled = page.locator("section").filter({
    has: page.getByRole("heading", { name: "启用用户", exact: true }),
  });
  await expect(enabled).toContainText("1 / 1");
  await expect(
    page.getByRole("heading", { name: "所选期间暂无已上报用量", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "节点用量", exact: true }),
  ).toHaveCount(0);
  let unavailable = true;
  let failedRequests = 0;
  await page.route(
    "**/rpc/bifurcation.panel.v1.AdminUserService/ListUsers",
    async (route) => {
      if (!unavailable) return route.continue();
      failedRequests++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "unavailable",
          message: "用户列表暂时不可用",
        }),
      });
    },
  );
  // Exercise the real refreshInterval, keeping the same mounted cache key.
  await expect
    .poll(() => failedRequests, { timeout: 40_000 })
    .toBeGreaterThan(0);
  const feedback = page.getByRole("alert").filter({ hasText: "刷新失败" });
  await expect(feedback).toContainText("上海时间");
  await expect(enabled).toContainText("1 / 1");
  const beforeRetry = failedRequests;
  await feedback.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect.poll(() => failedRequests).toBeGreaterThan(beforeRetry);
  await expect(feedback).toBeVisible();
  await expect(enabled).toContainText("1 / 1");
  expect(errors).toEqual([]);
  unavailable = false;
  await feedback.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(feedback).toHaveCount(0);
  await expect(enabled).toContainText("1 / 1");

  // A different period must not inherit the previous period's successful data.
  await page.route(
    "**/rpc/bifurcation.panel.v1.UsageService/QueryUsage",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          code: "unavailable",
          message: "用量暂时不可用",
        }),
      }),
  );
  await page.getByRole("combobox", { name: "时间范围", exact: true }).click();
  await page.getByRole("option", { name: "最近 7 天", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "数据暂时无法加载" }),
  ).toBeVisible();
  await expect(page.getByText("刷新失败", { exact: false })).toHaveCount(0);
  // Revoked authentication is not a recoverable network outage: stop showing
  // the cached administrator data after the server denies the next refresh.
  await page.unroute("**/rpc/bifurcation.panel.v1.UsageService/QueryUsage");
  const logout = await rpc(
    page.request,
    app.origin,
    "bifurcation.panel.v1.AuthService/Logout",
  );
  expect(logout.status).toBe(200);
  await expect(enabled).toContainText("—", { timeout: 40_000 });
  await expect(enabled).not.toContainText("1 / 1");
  await expect(page.getByText("刷新失败", { exact: false })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("account confirmations and last-administrator controls work on a narrow viewport", async ({
  page,
  app,
}) => {
  await activate(page, app);
  const key = await rpc<{ id: string; token: string }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.MeService/CreateApiKey",
    { name: "Mobile automation" },
  );
  expect(key.status).toBe(200);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  const row = page.getByRole("row").filter({ hasText: "Mobile automation" });
  await row.getByRole("button", { name: "撤销", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("当前登录和客户端订阅不受影响");
  const bounds = await confirm.boundingBox();
  expect(
    bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390,
  ).toBeTruthy();
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "撤销", exact: true }),
  ).toBeFocused();
  const active = await rpc(
    page.request,
    app.origin,
    "bifurcation.panel.v1.MeService/GetMe",
    {},
    { Authorization: `Bearer ${key.body.token}` },
  );
  expect(active.status).toBe(200);
  await row.getByRole("button", { name: "撤销", exact: true }).click();
  await confirm
    .getByRole("button", { name: "撤销 API Key", exact: true })
    .click();
  await expect(row).toContainText("已撤销");
  const revoked = await rpc(
    page.request,
    app.origin,
    "bifurcation.panel.v1.MeService/GetMe",
    {},
    { Authorization: `Bearer ${key.body.token}` },
  );
  expect(revoked.status).toBe(401);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await page.goto(`${app.origin}/admin/users`);
  const admin = page.getByRole("row").filter({ hasText: app.username });
  await expect(
    admin.getByRole("button", { name: "禁用", exact: true }),
  ).toBeDisabled();
  await expect(admin).toContainText("不能禁用或降级");
  await admin.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog");
  await expect(
    edit.getByRole("combobox", { name: "角色", exact: true }),
  ).toBeDisabled();
  await edit.getByLabel("每月额度（GiB）", { exact: true }).fill("8");
  await edit.getByRole("button", { name: "编辑用户", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(admin).toContainText("8 GiB");
  await expect(admin).toContainText("管理员");
  await admin.getByRole("button", { name: "编辑", exact: true }).click();
  await edit.getByLabel("每月额度（GiB）", { exact: true }).fill("9");
  await edit.getByRole("button", { name: "取消", exact: true }).click();
  await admin.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(edit.getByLabel("每月额度（GiB）", { exact: true })).toHaveValue(
    "8",
  );
  await edit.getByLabel("每月额度（GiB）", { exact: true }).fill("0");
  await edit.getByRole("button", { name: "编辑用户", exact: true }).click();
  await page.goto(`${app.origin}/overview`);
  const remaining = page.locator("section").filter({
    has: page.getByRole("heading", { name: "本月剩余", exact: true }),
  });
  await expect(remaining).toContainText("0 GiB");
  await expect(
    page.getByText("本月额度已用尽", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
