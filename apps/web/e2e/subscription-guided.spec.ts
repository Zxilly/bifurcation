import { readFile } from "node:fs/promises";
import { test, expect, activate, logout } from "./fixtures";
import { readySubscriptionNode } from "./subscription-fixture";
import { rpc } from "./rpc";

const me = "bifurcation.panel.v1.MeService";
type Binding = { groupTag: string; regions?: string[]; tags?: string[]; protocols?: string[]; machineIds?: string[]; excludeMachineIds?: string[]; staticMembers?: string[] };
type Profile = { id: string; version: number; name: string; url: string; draft: { templateJson: string; bindings: Binding[] } };

test("an invited user publishes phone and PC subscriptions by named nodes without editing JSON", async ({ page, app, playwright }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await activate(page, app);
  const admin = await playwright.request.newContext();
  expect((await rpc(admin, app.origin, "bifurcation.panel.v1.AuthService/PasswordLogin", { username: app.username, password: app.password })).status).toBe(200);
  const invite = await rpc<{ activationUrl: string }>(admin, app.origin, "bifurcation.panel.v1.AdminUserService/CreateUser", { username: "guided-member", role: "ROLE_USER" });
  expect(invite.status).toBe(200);
  await logout(page, app);
  await page.goto(invite.body.activationUrl);
  await page.getByLabel("后备密码", { exact: true }).fill("disposable-member-password");
  await page.getByLabel("确认后备密码", { exact: true }).fill("disposable-member-password");
  await page.getByRole("button", { name: "设置密码并激活", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/account`);
  const tokyo = await readySubscriptionNode(admin, app.origin, "东京日常", "日本");
  const hongkong = await readySubscriptionNode(admin, app.origin, "香港备用", "香港");
  try {
    await page.getByRole("link", { name: "接入与订阅", exact: true }).click();
    const profiles: Profile[] = [];
    for (const [name, preset] of [["我的手机", "手机"], ["我的 PC", "PC"]]) {
      await page.getByRole("button", { name: "创建订阅", exact: true }).click();
      await page.getByLabel("订阅名称", { exact: true }).fill(name);
      await page.getByRole("combobox", { name: "初始模板", exact: true }).click();
      await page.getByRole("option", { name: preset, exact: true }).click();
      await page.getByRole("button", { name: "创建并编辑", exact: true }).click();
      await expect(page.getByRole("tabpanel", { name: "选择节点", exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "客户端基础配置 JSON", exact: true })).not.toBeVisible();
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      const original = (await rpc<{ profile: Profile }>(page.request, app.origin, `${me}/GetSubscriptionProfile`, { id })).body.profile;
      expect(original.draft.bindings.find((binding) => binding.groupTag === "select-ai")?.tags).toEqual(["ai"]);
      await page.getByRole("tab", { name: "节点组与属性", exact: true }).click();
      await page.getByRole("tab", { name: "选择节点", exact: true }).click();
      await expect(page.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
      const untouched = (await rpc<{ profile: Profile }>(page.request, app.origin, `${me}/GetSubscriptionProfile`, { id })).body.profile;
      expect(untouched.draft).toEqual(original.draft);
      const denied = await rpc<{ code: string; message: string }>(page.request, app.origin, `${me}/PreviewSubscriptionProfile`, { id, expectedVersion: original.version });
      expect(denied.status).toBe(400);
      expect(denied.body.code).toBe("invalid_argument");
      expect(denied.body.message).toContain("/bindings/select-ai");

      for (const use of ["日常访问", "AI 服务", "游戏"]) {
        await page.getByRole("button", { name: `选择${use}节点`, exact: true }).click();
        const dialog = page.getByRole("region", { name: `选择${use}节点`, exact: true });
        await dialog.getByRole("checkbox", { name: "东京日常 · 日本", exact: true }).setChecked(true);
        await dialog.getByRole("checkbox", { name: "香港备用 · 香港", exact: true }).setChecked(false);
        await dialog.getByRole("button", { name: "应用到本订阅草稿", exact: true }).click();
      }
      await page.getByRole("button", { name: "生成预览", exact: true }).click();
      await expect(page.getByRole("heading", { name: "订阅配置预览", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "发布此订阅", exact: true }).click();
      await expect(page.getByRole("heading", { name: "添加到客户端", exact: true })).toBeFocused();
      const saved = (await rpc<{ profile: Profile }>(page.request, app.origin, `${me}/GetSubscriptionProfile`, { id })).body.profile;
      expect(saved.draft.templateJson).toBe(original.draft.templateJson);
      for (const binding of saved.draft.bindings) {
        expect(binding.machineIds).toEqual([tokyo.id]);
        expect(binding.tags ?? []).toEqual([]);
        expect(binding.staticMembers ?? []).toEqual(original.draft.bindings.find((entry) => entry.groupTag === binding.groupTag)?.staticMembers ?? []);
      }
      // Real Clipboard API and download, with explicit permission scoped to this disposable app.
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: app.origin });
      await page.getByRole("button", { name: "复制订阅链接", exact: true }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(saved.url);
      const download = page.waitForEvent("download");
      await page.getByRole("link", { name: "下载已发布配置", exact: true }).click();
      const config = JSON.parse(await readFile((await (await download).path())!, "utf8"));
      for (const tag of ["select", "auto", "select-ai", "auto-ai", "select-game", "auto-game"]) {
        const members = config.outbounds.find((outbound: { tag: string }) => outbound.tag === tag).outbounds as string[];
        expect(members.some((member) => member.includes(tokyo.id))).toBe(true);
        expect(members.some((member) => member.includes(hongkong.id))).toBe(false);
      }
      profiles.push(saved);
      await page.getByRole("link", { name: "返回订阅列表", exact: true }).click();
    }
    expect(profiles[0].url).not.toBe(profiles[1].url);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${app.origin}/subscription/${profiles[0].id}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "选择AI 服务节点", exact: true }).click();
    const dialog = page.getByRole("region", { name: "选择AI 服务节点", exact: true });
    await dialog.getByRole("checkbox", { name: "东京日常 · 日本", exact: true }).setChecked(false);
    await expect(dialog.getByRole("button", { name: "应用到本订阅草稿", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "取消选择", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();

    // A custom group with no automatic-group reference must remain independent.
    const custom = (await rpc<{ profile: Profile }>(page.request, app.origin, `${me}/CreateSubscriptionProfile`, { name: "自定义组", preset: "desktop", requestKey: crypto.randomUUID() })).body.profile;
    custom.draft.bindings.find((binding) => binding.groupTag === "select-ai")!.staticMembers = [];
    expect((await rpc(page.request, app.origin, `${me}/SaveSubscriptionDraft`, { id: custom.id, name: custom.name, expectedVersion: custom.version, draft: custom.draft })).status).toBe(200);
    await page.goto(`${app.origin}/subscription/${custom.id}`);
    await page.getByRole("button", { name: "选择select-ai节点", exact: true }).click();
    await page.getByRole("region", { name: "选择select-ai节点", exact: true }).getByRole("checkbox", { name: "东京日常 · 日本", exact: true }).setChecked(true);
    await page.getByRole("button", { name: "应用到本订阅草稿", exact: true }).click();
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
    const independent = (await rpc<{ profile: Profile }>(page.request, app.origin, `${me}/GetSubscriptionProfile`, { id: custom.id })).body.profile;
    expect(independent.draft.bindings.find((binding) => binding.groupTag === "select-ai")?.machineIds).toEqual([tokyo.id]);
    expect(independent.draft.bindings.find((binding) => binding.groupTag === "auto-ai")).toEqual(custom.draft.bindings.find((binding) => binding.groupTag === "auto-ai"));
    expect(errors).toEqual([]);
  } finally {
    await tokyo.peer.close(); await hongkong.peer.close(); await admin.dispose();
  }
});
