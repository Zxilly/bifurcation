import { test, expect, activate } from "./fixtures";

test("Kumo selection, clipboard fallback and mobile navigation preserve user actions", async ({
  page,
  app,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await activate(page, app);
  await page.getByRole("link", { name: "用户", exact: true }).click();
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
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
  await page
    .getByRole("button", { name: "查看完整内容 / 手动复制", exact: true })
    .click();
  const fullText = page.getByLabel("完整内容", { exact: true });
  await expect(fullText).toBeVisible();
  const value = await fullText.inputValue();
  expect(value.startsWith(`${app.origin}/activate?token=`)).toBe(true);
  await fullText.focus();
  expect(
    await fullText.evaluate(
      (element: HTMLTextAreaElement) =>
        element.selectionStart === 0 &&
        element.selectionEnd === element.value.length,
    ),
  ).toBe(true);
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
