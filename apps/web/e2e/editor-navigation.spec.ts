import { test, expect, activate } from "./fixtures";
import { rpc } from "./rpc";

test("editor navigation keeps changes until explicitly discarded", async ({ page, app }) => {
  await activate(page, app);
  const created = await rpc<{ profile: { id: string } }>(page.request, app.origin,
    "bifurcation.panel.v1.MeService/CreateSubscriptionProfile",
    { name: "Navigation draft", preset: "desktop", requestKey: crypto.randomUUID() });
  const editorUrl = `${app.origin}/subscription/${created.body.profile.id}`;
  await page.goto(`${app.origin}/subscription`);
  await page.getByRole("link", { name: "Navigation draft", exact: true }).click();
  await page.getByLabel("订阅名称", { exact: true }).fill("Keep my changes");
  await page.getByRole("link", { name: "返回订阅列表", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "放弃未保存的修改？" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByLabel("订阅名称", { exact: true })).toHaveValue("Keep my changes");
  await page.evaluate(() => window.history.back());
  await expect(confirm).toBeVisible();
  await expect(page).toHaveURL(editorUrl);
  await confirm.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByLabel("订阅名称", { exact: true })).toHaveValue("Keep my changes");
  await page.evaluate(() => window.history.back());
  await confirm.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/subscription`);
  await page.goForward();
  await expect(page).toHaveURL(editorUrl);
  await page.getByLabel("订阅名称", { exact: true }).fill("Keep my changes");
  await page.getByRole("link", { name: "账号设置", exact: true }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/account`);
  await page.goto(editorUrl);
  await expect(page.getByLabel("订阅名称", { exact: true })).toHaveValue("Navigation draft");
  await page.getByLabel("订阅名称", { exact: true }).fill("Saved draft");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByText("草稿已保存。生成预览并发布后，客户端才可下载配置。", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回订阅列表", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/subscription`);
  await expect(confirm).toHaveCount(0);

  const machine = await rpc<{ machine: { id: string } }>(page.request, app.origin,
    "bifurcation.panel.v1.AdminMachineService/CreateMachine", { name: "Navigation node", address: "192.0.2.10" });
  await page.goto(`${app.origin}/admin/machines/${machine.body.machine.id}/configuration`);
  await page.getByLabel("TLS 服务器名称", { exact: true }).fill("draft.example.test");
  await page.getByRole("link", { name: "返回机器详情", exact: true }).click();
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("TLS 服务器名称", { exact: true })).toHaveValue("draft.example.test");
  await page.getByRole("link", { name: "返回机器详情", exact: true }).click();
  await confirm.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/admin/machines/${machine.body.machine.id}`);
});
