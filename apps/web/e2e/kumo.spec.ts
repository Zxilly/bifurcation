import { test, expect, activate, copyValueText } from "./fixtures";

for (const width of [1440, 390]) {
  test(`Kumo dialog is centered in the full viewport at ${width}px`, async ({ page, app }) => {
    await activate(page, app);
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "创建 API Key", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect.poll(async () => dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const leftMargin = bounds.left;
      const rightMargin = innerWidth - bounds.right;
      return Math.abs(leftMargin - rightMargin);
    }), { message: `Dialog left and right viewport margins are equal at ${width}px` }).toBeLessThanOrEqual(1);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
}

test("Kumo selection, clipboard fallback and mobile navigation preserve user actions", async ({
  page,
  app,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await activate(page, app);
  await page.getByRole("link", { name: "用户", exact: true }).click();
  await page.evaluate(() => {
    const transitions: string[] = [];
    Object.assign(window, { dialogTransitions: transitions });
    document.addEventListener("transitionrun", (event) => {
      if (event.target instanceof HTMLElement && event.target.getAttribute("role") === "dialog") {
        transitions.push((event as TransitionEvent).propertyName);
      }
    });
  });
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { dialogTransitions: string[] }).dialogTransitions)).toEqual(expect.arrayContaining(["scale", "opacity"]));
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "创建用户", exact: true }),
  ).toHaveCSS("font-size", "24px");
  await page.getByLabel("用户名", { exact: true }).fill("kumo-user");
  const role = page.getByRole("combobox", { name: "角色", exact: true });
  await role.click();
  await page.getByRole("option", { name: "管理员", exact: true }).click();
  await expect(role).toContainText("管理员");
  await role.click();
  await page.getByRole("option", { name: "用户", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "创建用户", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "用户已创建", exact: true }),
  ).toBeVisible();
  // A denied clipboard must still leave the exact value available for manual copying.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException("Denied", "NotAllowedError");
        },
      },
    });
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "复制", exact: true })
    .click();
  await expect(page.getByText("已复制", { exact: true })).toHaveCount(0);
  const fullText = copyValueText(page.getByRole("dialog"));
  await expect(fullText).toBeVisible();
  const value = await fullText.innerText();
  expect(value.startsWith(`${app.origin}/activate?token=`)).toBe(true);
  await expect(page.getByRole("status")).toContainText("无法访问剪贴板");
  const manual = page.getByRole("textbox", { name: "完整内容", exact: true });
  await expect(manual).toHaveValue(value);
  await manual.focus();
  expect(await manual.evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!)).toBe(value.length);
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(
    page
      .getByRole("row")
      .filter({
        has: page.getByRole("cell", { name: "kumo-user", exact: true }),
      })
      .getByRole("cell", { name: "用户", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByRole("button", { name: "打开导航", exact: true });
  await toggle.click();
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page.getByRole("link", { name: "账号设置", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/account`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(
    await page.evaluate(() => document.body.scrollWidth <= innerWidth),
  ).toBe(true);
  expect(errors).toEqual([]);
});
