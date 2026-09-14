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
  for (const width of [1920, 1440, 390]) {
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
      expect(box.width).toBeLessThanOrEqual(1480);
      expect(box.overflow, `${route} horizontal overflow at ${width}`).toBe(
        false,
      );
    }
  }
});
