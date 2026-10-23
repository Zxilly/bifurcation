import type { Page } from "@playwright/test";
import { test, expect, activate } from "./fixtures";
import { connectMachine } from "./machine-fixture";
import { jsonEditor } from "./json-editor";
import { rpc } from "./rpc";

type Profile = {
  id: string;
  name: string;
  version: number;
  url: string;
  publishedVersion?: number;
  draft: {
    templateJson: string;
    bindings: { groupTag: string; regions: string[]; tags: string[] }[];
  };
};
const me = "bifurcation.panel.v1.MeService";

async function createProfile(page: Page, origin: string, name: string) {
  const created = await rpc<{ profile: Profile }>(page.request, origin, `${me}/CreateSubscriptionProfile`, {
    name, preset: "desktop", requestKey: crypto.randomUUID(),
  });
  expect(created.status).toBe(200);
  return created.body.profile;
}
async function getProfile(page: Page, origin: string, id: string) {
  const response = await rpc<{ profile: Profile }>(page.request, origin, `${me}/GetSubscriptionProfile`, { id });
  expect(response.status).toBe(200);
  return response.body.profile;
}

test("subscription group input survives keyboard tabs, renaming and removing earlier bindings", async ({ page, app }) => {
  await activate(page, app);
  const profile = await createProfile(page, app.origin, "节点组编辑");
  await page.goto(`${app.origin}/subscription/${profile.id}`);
  const templateTab = page.getByRole("tab", { name: "高级 JSON 配置", exact: true });
  const groupsTab = page.getByRole("tab", { name: "节点组与属性", exact: true });
  // Wait for a visible client-side tab change before checking keyboard navigation.
  await templateTab.click();
  await expect(templateTab).toHaveAttribute("aria-selected", "true");
  await templateTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(groupsTab).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(groupsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "节点组与属性", exact: true })).toBeVisible();

  await page.getByLabel("auto · 地区", { exact: true }).fill("日本, 新加坡,");
  await templateTab.click();
  await groupsTab.click();
  await expect(page.getByLabel("auto · 地区", { exact: true })).toHaveValue("日本, 新加坡,");
  await page.getByLabel("组 2 tag", { exact: true }).fill("auto-renamed");
  await page.getByRole("button", { name: "移除此绑定", exact: true }).first().click();
  await expect(page.getByLabel("组 1 tag", { exact: true })).toHaveValue("auto-renamed");
  await expect(page.getByLabel("auto-renamed · 地区", { exact: true })).toHaveValue("日本, 新加坡,");

  await page.getByLabel("auto-renamed · 标签", { exact: true }).fill("ai, game");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "草稿已保存" })).toBeVisible();
  const saved = await getProfile(page, app.origin, profile.id);
  expect(saved.draft.bindings[0]).toMatchObject({ groupTag: "auto-renamed", regions: ["日本", "新加坡"], tags: ["ai", "game"] });
  expect(saved.draft.bindings).toHaveLength(profile.draft.bindings.length - 1);
  await page.reload();
  await groupsTab.click();
  await expect(page.getByLabel("auto-renamed · 地区", { exact: true })).toHaveValue("日本, 新加坡");
  await expect(page.getByLabel("auto-renamed · 标签", { exact: true })).toHaveValue("ai, game");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a conflicting subscription draft stays intact until the user confirms loading the latest version", async ({ page, app }) => {
  await activate(page, app);
  const profile = await createProfile(page, app.origin, "原始草稿");
  await page.goto(`${app.origin}/subscription/${profile.id}`);
  await page.getByRole("tab", { name: "高级 JSON 配置", exact: true }).click();
  const editor = jsonEditor(page, "客户端基础配置 JSON");
  const localJson = '{"log":{"level":"debug"},"outbounds":[]}';
  const remoteJson = '{"log":{"level":"warn"},"outbounds":[]}';
  await page.getByLabel("订阅名称", { exact: true }).fill("本页未保存修改");
  await editor.fill(localJson);
  const updated = await rpc<{ profile: Profile }>(page.request, app.origin, `${me}/SaveSubscriptionDraft`, {
    id: profile.id, expectedVersion: profile.version, name: "另一页的新草稿",
    draft: { ...profile.draft, templateJson: remoteJson },
  });
  expect(updated.status).toBe(200);
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "订阅已在其他页面更新" })).toBeVisible();
  await expect(page.getByLabel("订阅名称", { exact: true })).toHaveValue("本页未保存修改");
  expect(await editor.value()).toBe(localJson);
  expect((await getProfile(page, app.origin, profile.id)).draft.templateJson).toBe(remoteJson);

  await page.getByRole("button", { name: "载入最新草稿", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "载入最新草稿", exact: true });
  await confirm.getByRole("button", { name: "继续保留当前编辑", exact: true }).click();
  await expect(confirm).not.toBeVisible();
  expect(await editor.value()).toBe(localJson);
  await page.getByRole("button", { name: "载入最新草稿", exact: true }).click();
  await confirm.getByRole("button", { name: "放弃当前编辑并载入", exact: true }).click();
  await expect(confirm).not.toBeVisible();
  await expect(page.getByLabel("订阅名称", { exact: true })).toHaveValue("另一页的新草稿");
  await expect.poll(() => editor.value()).toBe(remoteJson);
  await page.getByLabel("订阅名称", { exact: true }).fill("合并后继续编辑");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "草稿已保存" })).toBeVisible();
  expect((await getProfile(page, app.origin, profile.id)).name).toBe("合并后继续编辑");
});

test("an expired subscription preview offers regeneration before publishing a real downloadable configuration", async ({ page, app }) => {
  await activate(page, app);
  const created = await rpc<{ machine: { id: string; token: string } }>(page.request, app.origin, "bifurcation.panel.v1.AdminMachineService/CreateMachine", {
    name: "Preview fixture", address: "preview.test", region: "日本",
  });
  expect(created.status).toBe(200);
  const machine = created.body.machine;
  const peer = await connectMachine(app.origin, machine.token);
  try {
    const configuration = "bifurcation.panel.v1.AdminConfigurationService";
    const candidate = await rpc<{ preview: { previewId: string } }>(page.request, app.origin, `${configuration}/PreviewConfiguration`, {
      machineId: machine.id, expectedVersion: 0,
      settings: { listen: "::", trojanPort: 443, hysteria2Port: 8443, tls: { serverName: "preview.test", path: { certificatePath: "/etc/cert.pem", privateKeyPath: "/etc/key.pem" } } },
    });
    expect(candidate.status).toBe(200);
    const published = await rpc<{ revisionId: string; task: { id: string } }>(page.request, app.origin, `${configuration}/PublishConfiguration`, {
      machineId: machine.id, expectedVersion: 0, previewId: candidate.body.preview.previewId, requestKey: crypto.randomUUID(),
    });
    expect(published.status).toBe(200);
    const task = await peer.nextTask(published.body.task.id);
    await peer.call("AcceptTask", { sessionEpoch: peer.session.sessionEpoch, taskId: task.taskId, payloadSha256: task.payloadSha256 });
    const config = await peer.call<{ policyRevision: string; configSha256: string }>("GetConfig", { revisionId: published.body.revisionId });
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch, sequence: "1",
      status: { observedAtUnixMs: String(Date.now()), daemonVersion: "test", coreVersion: "1.14.0", coreHealth: "CORE_HEALTH_HEALTHY", appliedRevisionId: published.body.revisionId, appliedPolicyRevision: config.policyRevision, appliedConfigSha256: config.configSha256 },
    });
    const profile = await createProfile(page, app.origin, "预览有效期");
    const draft = { templateJson: JSON.stringify({ log: { level: "warn" }, outbounds: [{ type: "direct", tag: "direct" }], route: { final: "direct" } }), bindings: [] };
    const saved = await rpc(page.request, app.origin, `${me}/SaveSubscriptionDraft`, { id: profile.id, expectedVersion: profile.version, name: profile.name, draft });
    expect(saved.status).toBe(200);
    await page.goto(`${app.origin}/subscription/${profile.id}`);
    await page.clock.install();
    await page.getByRole("button", { name: "生成预览", exact: true }).click();
    await expect(page.getByRole("heading", { name: "订阅配置预览", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "发布此订阅", exact: true })).toBeVisible();
    await page.clock.fastForward(5 * 60_000 + 1_000);
    await expect(page.getByRole("status").filter({ hasText: "预览已过期" })).toBeVisible();
    await expect(page.getByRole("button", { name: "发布此订阅", exact: true })).toHaveCount(0);
    // Only the browser clock moved; align it with the server before requesting a fresh preview.
    await page.clock.setSystemTime(new Date());
    await page.getByRole("button", { name: "重新生成预览", exact: true }).click();
    await expect(page.getByRole("button", { name: "发布此订阅", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "发布此订阅", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "订阅配置已发布" })).toBeVisible();
    const result = await getProfile(page, app.origin, profile.id);
    expect(result.publishedVersion).toBeGreaterThan(0);
    const downloaded = await page.request.get(result.url);
    expect(downloaded.status()).toBe(200);
    expect((await downloaded.json()).log.level).toBe("warn");
  } finally {
    await peer.close();
  }
});
