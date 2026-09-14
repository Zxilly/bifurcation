import { test, expect, activate } from "./fixtures";
import { connectMachine } from "./machine-fixture";
import { rpc } from "./rpc";

test("machine navigation keeps runtime, maintenance and credentials distinct", async ({
  page,
  app,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await activate(page, app);
  const created = await rpc<{ machine: { id: string; token: string } }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.AdminMachineService/CreateMachine",
    {
      name: "Tokyo edge",
      address: "192.0.2.30",
      region: "东京",
      tags: ["ai", "game"],
    },
  );
  expect(created.status).toBe(200);
  const { machine } = created.body;
  const waiting = await rpc(
    page.request,
    app.origin,
    "bifurcation.panel.v1.AdminMachineService/CreateMachine",
    {
      name: "Frankfurt standby",
      address: "198.51.100.20",
      region: "法兰克福",
      tags: ["backup"],
    },
  );
  expect(waiting.status).toBe(200);
  const peer = await connectMachine(app.origin, machine.token, {
    daemonVersion: "0.1.0",
  });
  try {
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch,
      sequence: "1",
      status: {
        observedAtUnixMs: String(Date.now()),
        daemonVersion: "0.1.0",
        coreVersion: "1.14.0",
        maintenanceStatus: "MAINTENANCE_STATUS_CONTAINER",
        coreHealth: "CORE_HEALTH_NOT_CONFIGURED",
        cpuUsagePercent: 12.5,
        memoryUsedBytes: "536870912",
        memoryTotalBytes: "2147483648",
        diskFreeBytes: "17179869184",
        connections: "0",
      },
    });
    await page.goto(`${app.origin}/admin/machines/${machine.id}`);
    await expect(
      page.getByRole("heading", { name: "Tokyo edge", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("12.5%", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "概览", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      (await page
        .getByRole("tab", { name: "概览", exact: true })
        .getAttribute("id")) ?? "",
    );
    await expect(
      page.getByRole("heading", { name: "机器 Token", exact: true }),
    ).not.toBeVisible();

    await page.getByRole("tab", { name: "接入与维护", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "机器 Token", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "升级 daemon", exact: true }),
    ).toBeDisabled();
    await expect(
      page
        .getByRole("heading", { name: "版本与更新", exact: true })
        .locator("..")
        .locator(".."),
    ).toContainText("更新镜像并重建容器");

    await page.reload();
    await expect(
      page.getByRole("tab", { name: "接入与维护", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "接入与维护", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("tab", { name: "操作记录", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.goBack();
    await expect(
      page.getByRole("tab", { name: "接入与维护", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(
      page.getByRole("button", { name: "获取最近 100 行日志", exact: true }),
    ).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("link", { name: "返回机器列表", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Tokyo edge", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await page
      .getByRole("searchbox", { name: "搜索机器", exact: true })
      .fill("game");
    await expect(
      page.getByRole("link", { name: "Tokyo edge", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("searchbox", { name: "搜索机器", exact: true })
      .fill("absent");
    await expect(
      page.getByText("没有匹配的机器", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Tokyo edge", exact: true }),
    ).toBeVisible();
    await page.getByRole("combobox", { name: "机器状态", exact: true }).click();
    await page.getByRole("option", { name: "待接入", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Tokyo edge", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Frankfurt standby", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    peer.close();
  }
});
