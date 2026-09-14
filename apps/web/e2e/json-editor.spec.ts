import { test, expect, activate } from "./fixtures";
import { jsonEditor } from "./json-editor";

type MarkerWindow = Window & {
  monaco?: { editor: { getModelMarkers(filter: object): { message: string; severity: number }[] } };
};

test("the subscription editor validates and completes against the sing-box schema", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await activate(page, app);
  await page.goto(`${app.origin}/subscription`);
  await page.getByRole("button", { name: "创建订阅", exact: true }).click();
  await page.getByLabel("订阅名称", { exact: true }).fill("Schema check");
  await page.getByRole("button", { name: "创建并编辑", exact: true }).click();
  await expect(page.getByRole("heading", { name: "编辑订阅配置", exact: true })).toBeVisible();

  const editor = jsonEditor(page, "客户端基础配置 JSON");
  const markers = () =>
    page.evaluate(() =>
      (window as MarkerWindow).monaco!.editor.getModelMarkers({}).map((marker) => marker.message),
    );
  // A value outside the schema's enum is reported without any network fetch.
  await editor.fill('{"log":{"level":"verbose"}}');
  await expect.poll(markers).toContainEqual(expect.stringContaining("Valid values"));
  await editor.fill('{"log":{"level":"debug"}}');
  await expect.poll(markers).toEqual([]);

  // Completion proposals come from the same schema.
  await page.evaluate(() => {
    const { monaco } = window as Window & { monaco?: { editor: { getEditors(): { setPosition(p: object): void; trigger(s: string, id: string, a: unknown): void; focus(): void }[] } } };
    const [instance] = monaco!.editor.getEditors();
    instance.focus();
    instance.setPosition({ lineNumber: 1, column: 2 });
    instance.trigger("e2e", "editor.action.triggerSuggest", {});
  });
  // Monaco exposes suggestion rows as listitem or option depending on the browser.
  await expect(page.getByRole("listbox", { name: "Suggest" }).locator('[aria-label^="dns, Property"]')).toBeVisible();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});
