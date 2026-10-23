import { test, expect, activate } from "./fixtures";
import { rpc } from "./rpc";
import { jsonEditor } from "./json-editor";

test("subscription setup shows node selection without exposing JSON source or loading copy before hydration", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /hydration|did not match/i.test(message.text())) errors.push(message.text());
  });
  await activate(page, app);
  const created = await rpc<{ profile: { id: string } }>(page.request, app.origin,
    "bifurcation.panel.v1.MeService/CreateSubscriptionProfile",
    { name: "Loading state", preset: "desktop", requestKey: crypto.randomUUID() });
  expect(created.status).toBe(200);
  let releaseScripts!: () => void;
  const scriptsReady = new Promise<void>((resolve) => { releaseScripts = resolve; });
  await page.route("**/_next/**/*.js", async (route) => {
    await scriptsReady;
    await route.continue();
  });
  try {
    await page.goto(`${app.origin}/subscription/${created.body.profile.id}`, { waitUntil: "commit" });
    const placeholder = page.getByRole("status", { name: "客户端基础配置 JSON：正在加载编辑器", exact: true, includeHidden: true });
    await expect(placeholder).toBeHidden();
    await expect(placeholder).toHaveAttribute("aria-busy", "true");
    await expect(placeholder).toHaveText("");
    await expect(page.getByRole("tabpanel", { name: "选择节点", exact: true })).toBeVisible();
    await expect(page.getByText("正在加载 JSON 编辑器…", { exact: true })).toHaveCount(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally {
    releaseScripts();
  }
  // Releasing network requests does not mean the server-rendered tabs have
  // hydrated. Wait for the editor's own hydration boundary before clicking.
  await expect(page.getByRole("status", { name: "客户端基础配置 JSON：正在加载编辑器", exact: true, includeHidden: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "高级 JSON 配置", exact: true }).click();
  await expect(page.getByRole("tab", { name: "高级 JSON 配置", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(jsonEditor(page, "客户端基础配置 JSON").textbox).toBeVisible();
  await expect(page.getByRole("status", { name: "客户端基础配置 JSON：正在加载编辑器", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
