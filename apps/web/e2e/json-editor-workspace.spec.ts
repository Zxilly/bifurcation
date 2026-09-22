import type { Page } from "@playwright/test";
import { test, expect, activate } from "./fixtures";
import { jsonEditor } from "./json-editor";
import { rpc } from "./rpc";

const label = "客户端基础配置 JSON";
const me = "bifurcation.panel.v1.MeService";
type Profile = { id: string; draft: { templateJson: string } };
type EditorWindow = Window & {
  monaco?: {
    editor: {
      getEditors(): {
        getRawOptions(): { ariaLabel?: string };
        getPosition(): { lineNumber: number; column: number } | null;
        getScrollWidth(): number;
        getLayoutInfo(): { contentWidth: number };
      }[];
    };
  };
};

async function openEditor(page: Page, origin: string) {
  const result = await rpc<{ profile: Profile }>(page.request, origin, `${me}/CreateSubscriptionProfile`, {
    name: "JSON 编辑体验", preset: "desktop", requestKey: crypto.randomUUID(),
  });
  expect(result.status).toBe(200);
  await page.goto(`${origin}/subscription/${result.body.profile.id}`);
  await expect(page.getByRole("heading", { name: "编辑订阅配置", exact: true })).toBeVisible();
  return result.body.profile;
}

test("keyboard edits remain undoable across tabs and the save shortcut persists the draft", async ({ page, app }) => {
  await activate(page, app);
  const profile = await openEditor(page, app.origin);
  const editor = jsonEditor(page, label);
  const original = await editor.value();
  await editor.textbox.focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" ");
  await expect.poll(() => editor.value()).toBe(`${original} `);

  await page.getByRole("tab", { name: "节点组与属性", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "基础配置", exact: true })).not.toBeVisible();
  await page.getByRole("tab", { name: "基础配置", exact: true }).click();
  await editor.textbox.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => editor.value()).toBe(original);

  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" ");
  // Save immediately after the keystroke: React may not have committed the
  // latest controlled value yet, but Monaco already owns the current text.
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("status").filter({ hasText: "草稿已保存。生成预览并发布后" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
  const saved = await rpc<{ profile: Profile }>(page.request, app.origin, `${me}/GetSubscriptionProfile`, { id: profile.id });
  expect(saved.status).toBe(200);
  expect(saved.body.profile.draft.templateJson).toBe(`${original} `);
  await page.reload();
  expect(await editor.value()).toBe(`${original} `);
});

test("formatting and file import can be undone and schema issues navigate to their source", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await activate(page, app);
  const profile = await openEditor(page, app.origin);
  const editor = jsonEditor(page, label);
  const compact = '{"log":{"level":"warn"},"dns":{"cache_capacity":9223372036854775807}}';
  // Formatting must preserve numeric literals, including values above Number.MAX_SAFE_INTEGER.
  const formatted = '{\n  "log": {\n    "level": "warn"\n  },\n  "dns": {\n    "cache_capacity": 9223372036854775807\n  }\n}';
  await editor.fill(compact);
  await page.getByRole("button", { name: "格式化 JSON", exact: true }).click();
  await expect.poll(() => editor.value()).toBe(formatted);
  await editor.textbox.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => editor.value()).toBe(compact);

  const imported = '{"log":{"level":"debug"},"route":{"final":"direct"}}';
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入 JSON 文件", exact: true }).click();
  await (await chooser).setFiles({ name: "client.json", mimeType: "application/json", buffer: Buffer.from(imported) });
  await expect.poll(() => editor.value()).toBe(imported);
  await editor.textbox.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => editor.value()).toBe(compact);

  await editor.fill('{\n  "log": {\n    "level": "verbose"\n  }\n}');
  await page.getByRole("button", { name: /^问题（[1-9]\d*）/ }).click();
  const issue = page.getByRole("button", { name: /^第 3 行，第 \d+ 列：/ }).first();
  await expect(issue).toBeVisible();
  const position = (await issue.getAttribute("aria-label"))?.match(/^第 (\d+) 行，第 (\d+) 列：/);
  await issue.click();
  await expect(editor.textbox).toBeFocused();
  await expect.poll(() => page.evaluate((label) => {
    const instance = (window as EditorWindow).monaco!.editor.getEditors().find((candidate) => candidate.getRawOptions().ariaLabel === label)!;
    return instance.getPosition()?.lineNumber;
  }, label)).toBe(Number(position?.[1] ?? 3));
  await page.getByRole("button", { name: "查找 / 替换", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Find", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Replace", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const invalid = '{"log":';
  await editor.fill(invalid);
  await page.getByRole("button", { name: "格式化 JSON", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "JSON 格式有误" })).toBeVisible();
  expect(await editor.value()).toBe(invalid);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "草稿已保存。生成预览并发布后" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
  const saved = await rpc<{ profile: Profile }>(page.request, app.origin, `${me}/GetSubscriptionProfile`, { id: profile.id });
  expect(saved.body.profile.draft.templateJson).toBe(invalid);
  expect(errors).toEqual([]);
});

test("the mobile workspace wraps long values and expands without overflowing the page", async ({ page, app }) => {
  await activate(page, app);
  await page.setViewportSize({ width: 390, height: 844 });
  await openEditor(page, app.origin);
  const editor = jsonEditor(page, label);
  const value = JSON.stringify({ log: { output: `/var/log/${"client-".repeat(30)}.log` } });
  await editor.fill(value);
  const wrap = page.getByRole("button", { name: "自动换行", exact: true });
  const horizontalOverflow = () => page.evaluate((label) => {
    const instance = (window as EditorWindow).monaco!.editor.getEditors().find((candidate) => candidate.getRawOptions().ariaLabel === label)!;
    return instance.getScrollWidth() > instance.getLayoutInfo().contentWidth + 1;
  }, label);
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  await expect.poll(horizontalOverflow).toBe(false);
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  await expect.poll(horizontalOverflow).toBe(true);
  await wrap.click();
  await expect.poll(horizontalOverflow).toBe(false);

  const editorBox = page.locator(".monaco-editor");
  const originalHeight = (await editorBox.boundingBox())!.height;
  await page.getByRole("button", { name: "扩大编辑区", exact: true }).click();
  await expect(page.getByRole("button", { name: "收起编辑区", exact: true })).toBeVisible();
  await expect.poll(async () => (await editorBox.boundingBox())!.height).toBeGreaterThan(originalHeight);
  expect(await editor.value()).toBe(value);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "收起编辑区", exact: true }).click();
  await expect.poll(async () => (await editorBox.boundingBox())!.height).toBe(originalHeight);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
