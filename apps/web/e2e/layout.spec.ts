import { test, expect, activate } from "./fixtures";
import { rpc } from "./rpc";

test("all panel routes share content edges at desktop, wide and mobile widths", async ({
  page,
  app,
}) => {
  await activate(page, app);
  const machine = await rpc<{ machine: { id: string } }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.AdminMachineService/CreateMachine",
    { name: "Layout node", address: "192.0.2.40", region: "东京" },
  );
  const subscription = await rpc<{ profile: { id: string } }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.MeService/CreateSubscriptionProfile",
    {
      name: "Layout subscription",
      preset: "desktop",
      requestKey: crypto.randomUUID(),
    },
  );
  expect(machine.status).toBe(200);
  expect(subscription.status).toBe(200);
  const routes = [
    "/admin",
    "/admin/machines",
    `/admin/machines/${machine.body.machine.id}`,
    `/admin/machines/${machine.body.machine.id}/configuration`,
    "/admin/users",
    "/overview",
    "/subscription",
    `/subscription/${subscription.body.profile.id}`,
    "/account",
  ];
  for (const width of [1920, 1440, 1100, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    let reference: { x: number; width: number } | undefined;
    for (const route of routes) {
      await page.goto(`${app.origin}${route}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const box = await page.locator(".page-frame").evaluate((frame) => {
        const bounds = frame.getBoundingClientRect();
        const content = [...frame.children].find(
          (element) => element.getBoundingClientRect().width > 0,
        )!;
        const contentBounds = content.getBoundingClientRect();
        return {
          x: bounds.x,
          width: bounds.width,
          contentX: contentBounds.x,
          contentWidth: contentBounds.width,
          headingX: frame.querySelector("h1")!.getBoundingClientRect().x,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      reference ??= box;
      expect(
        Math.abs(box.x - reference.x),
        `${route} left edge at ${width}`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(box.width - reference.width),
        `${route} width at ${width}`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(box.contentX - box.x),
        `${route} inner left edge at ${width}`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(box.contentWidth - box.width),
        `${route} inner width at ${width}`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(box.headingX - box.x),
        `${route} heading alignment at ${width}`,
      ).toBeLessThanOrEqual(1);
      expect(box.width).toBeLessThanOrEqual(1200);
      expect(box.overflow, `${route} horizontal overflow at ${width}`).toBe(
        false,
      );
      if (width === 390 && route === `/subscription/${subscription.body.profile.id}`) {
        for (const name of ["保存草稿", "生成预览"]) {
          const offset = await page.getByRole("button", { name, exact: true }).evaluate((button) => {
            const bounds = button.getBoundingClientRect();
            const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
            const rectangles: DOMRect[] = [];
            while (walker.nextNode()) {
              const text = walker.currentNode;
              if (!text.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(text);
              rectangles.push(...[...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0));
            }
            if (!rectangles.length) throw new Error("Button has no rendered label");
            const textLeft = Math.min(...rectangles.map((rect) => rect.left));
            const textRight = Math.max(...rectangles.map((rect) => rect.right));
            return Math.abs((textLeft + textRight) / 2 - (bounds.left + bounds.width / 2));
          });
          expect(offset, `${name} label is centered inside its mobile button`).toBeLessThanOrEqual(1);
        }
      }
    }
  }
});
