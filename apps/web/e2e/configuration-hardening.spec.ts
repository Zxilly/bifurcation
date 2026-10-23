import { test, expect, activate } from "./fixtures";
import { rpc } from "./rpc";

const configurationService = "bifurcation.panel.v1.AdminConfigurationService";

test("changing the certificate source invalidates the machine preview on desktop and mobile", async ({ page, app }) => {
  await activate(page, app);
  const created = await rpc<{ machine: { id: string } }>(page.request, app.origin,
    "bifurcation.panel.v1.AdminMachineService/CreateMachine", { name: "Preview validation", address: "192.0.2.20" });
  expect(created.status).toBe(200);
  await page.goto(`${app.origin}/admin/machines/${created.body.machine.id}/configuration`);
  await page.getByLabel("TLS 服务器名称", { exact: true }).fill("node.example.test");
  await page.getByRole("button", { name: "生成预览", exact: true }).click();
  await expect(page.getByRole("heading", { name: "最终 sing-box JSON", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "证书来源", exact: true }).click();
  await page.getByRole("option", { name: "ACME 自动签发", exact: true }).click();
  await expect(page.getByRole("button", { name: "检查并发布", exact: true })).toHaveCount(0);
  await page.getByLabel("ACME 联系邮箱", { exact: true }).fill("admin@example.test");
  await page.getByText("高级基础配置（可选）", { exact: false }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => page.locator(".json-editor-host").evaluate((editor) => {
      const editorBounds = editor.getBoundingClientRect();
      const fieldsetBounds = editor.closest("fieldset")!.getBoundingClientRect();
      return editorBounds.right - fieldsetBounds.right;
    }), { message: `JSON editor must fit inside the form at ${width}px` }).toBeLessThanOrEqual(1);
  }
});

test("machine previews show their expiry and offer regeneration without losing the draft", async ({ page, app }) => {
  await activate(page, app);
  const created = await rpc<{ machine: { id: string } }>(page.request, app.origin,
    "bifurcation.panel.v1.AdminMachineService/CreateMachine", { name: "Expiring preview", address: "192.0.2.21" });
  expect(created.status).toBe(200);
  await page.route(`**/rpc/${configurationService}/PreviewConfiguration`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.preview.expiresAt = String(Date.now() + 3000);
    await route.fulfill({ response, json: body });
  });
  await page.goto(`${app.origin}/admin/machines/${created.body.machine.id}/configuration`);
  await page.getByLabel("TLS 服务器名称", { exact: true }).fill("draft.example.test");
  await page.getByLabel("Trojan 监听端口", { exact: true }).fill("4443");
  await page.getByRole("button", { name: "生成预览", exact: true }).click();
  await expect(page.getByText(/有效至.*上海时间/)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "预览已过期" })).toBeVisible();
  await expect(page.getByRole("button", { name: "检查并发布", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("TLS 服务器名称", { exact: true })).toHaveValue("draft.example.test");
  await expect(page.getByLabel("Trojan 监听端口", { exact: true })).toHaveValue("4443");
  await page.getByRole("button", { name: "重新生成预览", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "预览已过期" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "检查并发布", exact: true })).toBeVisible();
});
