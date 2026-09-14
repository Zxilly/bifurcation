import { test, expect, activate } from "./fixtures";
import { connectMachine } from "./machine-fixture";
import { rpc } from "./rpc";

test("one-time API keys, user and machine creation, and mobile navigation", async ({
  page,
  app,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await activate(page, app);
  await page.getByRole("button", { name: "创建 API Key", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("Test API key");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建 API Key", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "API Key 已创建", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "查看完整内容 / 手动复制", exact: true })
    .click();
  const token = await page.getByLabel("完整内容", { exact: true }).inputValue();
  expect(token.startsWith("bf_key_")).toBe(true);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("cell", { name: "Test API key", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "API Key 已创建", exact: true }),
  ).toHaveCount(0);
  // Boolean assertion avoids including the full credential in assertion output.
  expect((await page.locator("body").innerText()).includes(token)).toBe(false);
  const apiMe = await rpc<{ user: { username: string } }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.MeService/GetMe",
    {},
    { Authorization: `Bearer ${token}` },
  );
  expect(apiMe.status).toBe(200);
  expect(apiMe.body.user.username).toBe(app.username);

  await page.getByRole("link", { name: "用户", exact: true }).click();
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
  await page.getByLabel("用户名", { exact: true }).fill("test-user");
  await page.getByLabel("每月额度（GiB）", { exact: true }).fill("12");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建用户", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "用户已创建", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "test-user", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "12 GiB", exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "机器", exact: true }).click();
  await page.getByRole("button", { name: "添加机器", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("Test node");
  await page.getByLabel("地址", { exact: true }).fill("192.0.2.10");
  await page.getByLabel("区域", { exact: true }).fill("东京");
  await page.getByRole("button", { name: "创建机器", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Test node", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "首次安装", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "获取最近 100 行日志", exact: true }),
  ).toBeDisabled();
  const tokenSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "机器 Token", exact: true }),
  });
  await tokenSection
    .getByRole("button", { name: "查看完整内容 / 手动复制", exact: true })
    .click();
  const machineToken = await tokenSection
    .getByLabel("完整内容", { exact: true })
    .inputValue();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Test node", exact: true }),
  ).toBeVisible();
  expect((await page.locator("body").innerText()).includes(machineToken)).toBe(
    true,
  );
  const machineUrl = page.url();
  const peer = await connectMachine(app.origin, machineToken);
  try {
    await page.reload();
    await page.getByRole("button", { name: "编辑信息", exact: true }).click();
    await page.getByLabel("名称", { exact: true }).fill("Renamed node");
    await page.getByLabel("地址", { exact: true }).fill("192.0.2.11");
    await page.getByRole("button", { name: "保存信息", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Renamed node", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(machineUrl);
    await page
      .getByRole("button", { name: "替换安装实例", exact: true })
      .click();
    await expect(
      page.getByText("旧机器上的程序不会自动卸载。", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "替换安装实例", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "首次安装", exact: true }),
    ).toBeVisible();
    const newTokenSection = page.locator("section").filter({
      has: page.getByRole("heading", { name: "机器 Token", exact: true }),
    });
    await newTokenSection
      .getByRole("button", { name: "查看完整内容 / 手动复制", exact: true })
      .click();
    const newToken = await newTokenSection
      .getByLabel("完整内容", { exact: true })
      .inputValue();
    expect(newToken === machineToken).toBe(false);
    const machineId = machineUrl.split("/admin/machines/")[1];
    const detail = (
      await rpc<{
        machine: {
          installationId?: string;
          uninstalled: boolean;
          name: string;
        };
      }>(
        page.request,
        app.origin,
        "bifurcation.panel.v1.AdminMachineService/GetMachine",
        { machineId },
      )
    ).body;
    expect(detail.machine).toMatchObject({
      name: "Renamed node",
    });
    expect(detail.machine.uninstalled ?? false).toBe(false);
    expect(detail.machine.installationId ?? null).toBe(null);
  } finally {
    await peer.close();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.body.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("link", { name: "账号设置", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/account`);
  await expect(
    page.getByRole("cell", { name: "Test API key", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.body.scrollWidth <= innerWidth),
  ).toBe(true);
  await page.getByRole("button", { name: "创建 API Key", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const dialog = await page.getByRole("dialog").boundingBox();
  expect(
    dialog !== null && dialog.x >= 0 && dialog.x + dialog.width <= 390,
  ).toBe(true);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
