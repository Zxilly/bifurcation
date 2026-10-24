import { test, expect, activate } from "./fixtures";
import { rpc } from "./rpc";
import { readySubscriptionNode } from "./subscription-fixture";
import type { Locator } from "@playwright/test";

type Profile = { id: string; name: string; url: string; version: number };

async function expectActionsOnSameRow(row: Locator, primary: Locator) {
  const action = await primary.boundingBox();
  const more = await row.getByRole("button", { name: / 的更多操作$/ }).boundingBox();
  expect(action).not.toBeNull();
  expect(more).not.toBeNull();
  expect(
    Math.abs(action!.y + action!.height / 2 - (more!.y + more!.height / 2)),
    "Subscription primary action and more menu share a row center",
  ).toBeLessThanOrEqual(1);
}

test("subscription actions follow draft, paused and downloadable states on mobile", async ({
  page,
  app,
}) => {
  await activate(page, app);
  const draft = await rpc<{ profile: Profile }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.MeService/CreateSubscriptionProfile",
    { name: "手机日常与旅行", preset: "mobile", requestKey: crypto.randomUUID() },
  );
  expect(draft.status).toBe(200);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: app.origin,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${app.origin}/subscription`);
  const draftRow = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "手机日常与旅行", exact: true }),
  });
  await expect(
    draftRow.getByRole("link", { name: "编辑并发布", exact: true }),
  ).toHaveAttribute("href", `/subscription/${draft.body.profile.id}`);
  await expect(
    draftRow.getByRole("button", { name: "复制链接", exact: true }),
  ).toHaveCount(0);
  const nameBounds = await draftRow.getByRole("cell").first().boundingBox();
  const actionBounds = await draftRow.getByRole("cell").last().boundingBox();
  expect(nameBounds!.width).toBeGreaterThan(actionBounds!.width);
  await expectActionsOnSameRow(draftRow, draftRow.getByRole("link", { name: "编辑并发布", exact: true }));
  const nodes = page.getByRole("region", { name: "可用节点", exact: true });
  await expect(nodes).toContainText("现在仍可创建订阅、保存草稿");
  await expect(nodes.getByRole("table")).toHaveCount(0);
  await expect(page.getByLabel("完整订阅链接", { exact: true })).toHaveCount(0);

  await draftRow.getByRole("button", { name: "手机日常与旅行 的更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "复制链接", exact: true }).click();
  const linkDialog = page.getByRole("dialog");
  await expect(linkDialog).toContainText("订阅尚未发布，当前不能通过链接下载配置");
  await expect(linkDialog.getByLabel("完整订阅链接", { exact: true })).toHaveValue(draft.body.profile.url);
  expect((await page.request.get(draft.body.profile.url)).status()).toBe(422);
  await linkDialog.getByRole("button", { name: "复制链接", exact: true }).click();
  await expect(linkDialog).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("订阅尚未发布");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(draft.body.profile.url);

  const list = await rpc<{ profiles: Profile[] }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.MeService/ListSubscriptionProfiles",
  );
  const defaultProfile = list.body.profiles.find((profile) => profile.name === "默认订阅")!;
  const detail = await rpc<{ profile: Profile }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.MeService/GetSubscriptionProfile",
    { id: defaultProfile.id },
  );
  const readyRow = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "默认订阅", exact: true }),
  });
  await expect(readyRow).toContainText("等待节点");
  await expect(readyRow.getByRole("button", { name: "复制链接", exact: true })).toHaveCount(0);
  await readyRow.getByRole("button", { name: "默认订阅 的更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "复制链接", exact: true }).click();
  await expect(linkDialog).toContainText("当前没有已就绪的节点");
  await linkDialog.getByRole("button", { name: "复制链接", exact: true }).click();
  await expect(linkDialog).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(detail.body.profile.url);

  const node = await readySubscriptionNode(page.request, app.origin, "订阅可用节点", "日本");
  try {
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(readyRow).toContainText("可下载");
    await expectActionsOnSameRow(readyRow, readyRow.getByRole("button", { name: "复制链接", exact: true }));
    await readyRow.getByRole("button", { name: "复制链接", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已复制「默认订阅」");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(detail.body.profile.url);

    await readyRow.getByRole("button", { name: "默认订阅 的更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "暂停订阅", exact: true }).click();
    const pauseDialog = page.getByRole("alertdialog");
    await expect(pauseDialog).toContainText("恢复后仍可使用原地址");
    await pauseDialog.getByRole("button", { name: "取消", exact: true }).click();
    expect((await page.request.get(detail.body.profile.url)).status()).toBe(200);
    await readyRow.getByRole("button", { name: "默认订阅 的更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "暂停订阅", exact: true }).click();
    await pauseDialog.getByRole("button", { name: "暂停订阅", exact: true }).click();
    await expect(readyRow.getByRole("button", { name: "恢复订阅", exact: true })).toBeVisible();
    await expectActionsOnSameRow(readyRow, readyRow.getByRole("button", { name: "恢复订阅", exact: true }));
    expect((await page.request.get(detail.body.profile.url)).status()).toBe(403);

    await readyRow.getByRole("button", { name: "默认订阅 的更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "复制链接", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("订阅已暂停，当前不能通过链接下载配置");
    await page.keyboard.press("Escape");
    await readyRow.getByRole("button", { name: "恢复订阅", exact: true }).click();
    const resumeDialog = page.getByRole("dialog");
    await expect(resumeDialog).toContainText("仍需有可生成的已发布配置");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await resumeDialog.getByRole("button", { name: "恢复订阅", exact: true }).click();
    await expect(readyRow.getByRole("button", { name: "复制链接", exact: true })).toBeVisible();
    expect((await page.request.get(detail.body.profile.url)).status()).toBe(200);
    await page.getByRole("button", { name: "重置代理凭据", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toContainText("所有订阅将使用新代理凭据");
    await page.getByRole("alertdialog").getByRole("button", { name: "取消", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await node.peer.close();
  }
});

test("subscription limit disables creation and duplication until a subscription is deleted", async ({
  page,
  app,
}) => {
  await activate(page, app);
  const list = await rpc<{ profiles: Profile[] }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.MeService/ListSubscriptionProfiles",
  );
  for (let index = list.body.profiles.length; index < 20; index++) {
    const created = await rpc<{ profile: Profile }>(
      page.request,
      app.origin,
      "bifurcation.panel.v1.MeService/CreateSubscriptionProfile",
      { name: `设备 ${index}`, preset: "desktop", requestKey: crypto.randomUUID() },
    );
    expect(created.status).toBe(200);
  }
  await page.goto(`${app.origin}/subscription`);
  await expect(page.getByText("已达到 20 条订阅上限。删除不再使用的订阅后，可继续创建或复制。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建订阅", exact: true })).toBeDisabled();
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "设备 19", exact: true }),
  });
  await row.getByRole("button", { name: "设备 19 的更多操作", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "复制为新订阅", exact: true })).toBeDisabled();
  await page.getByRole("menuitem", { name: "删除订阅", exact: true }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("删除后无法恢复");
  await confirm.getByRole("button", { name: "删除订阅", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("button", { name: "创建订阅", exact: true })).toBeEnabled();
  await expect(page.getByText("已创建 19 / 20 条订阅", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "创建订阅", exact: true }).click();
  await page.getByLabel("订阅名称", { exact: true }).fill("备用设备");
  await page.getByRole("button", { name: "创建并编辑", exact: true }).click();
  await expect(page.getByRole("heading", { name: "编辑订阅配置", exact: true })).toBeVisible();
  const afterCreate = await rpc<{ profiles: Profile[] }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.MeService/ListSubscriptionProfiles",
  );
  expect(afterCreate.body.profiles).toHaveLength(20);
  expect(afterCreate.body.profiles.some((profile) => profile.name === "备用设备")).toBe(true);
});
