import { test, expect, activate } from "./fixtures";
import { connectMachine } from "./machine-fixture";
import { rpc } from "./rpc";
import { jsonEditor } from "./json-editor";

test("phone and PC subscriptions share attributed nodes and keep rules, drafts and links independent", async ({
  page,
  app,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await activate(page, app);
  const created = await rpc<{ machine: { id: string; token: string } }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.AdminMachineService/CreateMachine",
    { name: "Shared node", address: "node.test", region: "日本" },
  );
  expect(created.status).toBe(200);
  const machine = created.body.machine;
  const peer = await connectMachine(app.origin, machine.token);
  try {
    await page.goto(`${app.origin}/admin/machines/${machine.id}`);
    await page.getByRole("button", { name: "编辑信息", exact: true }).click();
    await page.getByLabel("节点标签", { exact: true }).fill("ai, game");
    await page.getByRole("button", { name: "保存信息", exact: true }).click();
    await expect(
      page.locator(".machine-identity-line").getByText("ai", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(".machine-identity-line").getByText("game", { exact: true }),
    ).toBeVisible();
    const current = await rpc<{ machine: { version: number } }>(
      page.request,
      app.origin,
      "bifurcation.panel.v1.AdminMachineService/GetMachine",
      { machineId: machine.id },
    );
    const renamed = await rpc<{ machine: { tags: string[] } }>(
      page.request,
      app.origin,
      "bifurcation.panel.v1.AdminMachineService/UpdateMachine",
      {
        machineId: machine.id,
        expectedVersion: current.body.machine.version,
        name: "Shared node",
      },
    );
    expect(renamed.body.machine.tags).toEqual(["ai", "game"]);
    const preview = await rpc<{
      preview: { previewId: string; policyRevision: string };
    }>(
      page.request,
      app.origin,
      "bifurcation.panel.v1.AdminConfigurationService/PreviewConfiguration",
      {
        machineId: machine.id,
        expectedVersion: 0,
        settings: {
          listen: "::",
          trojanPort: 443,
          hysteria2Port: 8443,
          tls: {
            serverName: "node.test",
            path: {
              certificatePath: "/etc/cert.pem",
              privateKeyPath: "/etc/key.pem",
            },
          },
        },
      },
    );
    expect(preview.status).toBe(200);
    const published = await rpc<{ revisionId: string; task: { id: string } }>(
      page.request,
      app.origin,
      "bifurcation.panel.v1.AdminConfigurationService/PublishConfiguration",
      {
        machineId: machine.id,
        expectedVersion: 0,
        previewId: preview.body.preview.previewId,
        requestKey: crypto.randomUUID(),
      },
    );
    expect(published.status).toBe(200);
    const task = await peer.nextTask(published.body.task.id);
    await peer.call("AcceptTask", {
      sessionEpoch: peer.session.sessionEpoch,
      taskId: task.taskId,
      payloadSha256: task.payloadSha256,
    });
    const config = await peer.call<{
      policyRevision: string;
      configSha256: string;
    }>("GetConfig", { revisionId: published.body.revisionId });
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch,
      sequence: "1",
      status: {
        observedAtUnixMs: String(Date.now()),
        daemonVersion: "test",
        coreVersion: "1.14.0",
        coreHealth: "CORE_HEALTH_HEALTHY",
        appliedRevisionId: published.body.revisionId,
        appliedPolicyRevision: config.policyRevision,
        appliedConfigSha256: config.configSha256,
      },
    });
    await page.goto(`${app.origin}/subscription`);
    await expect(
      page.getByRole("cell", { name: "Shared node", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("查看完整内容 / 手动复制", { exact: true }),
    ).toHaveCount(0);
    const ids: string[] = [];
    for (const [name, preset, level] of [
      ["PC 规则", "PC", "debug"],
      ["手机规则", "手机", "warn"],
    ]) {
      await page.getByRole("button", { name: "创建订阅", exact: true }).click();
      await page.getByLabel("订阅名称", { exact: true }).fill(name);
      await page
        .getByRole("combobox", { name: "初始模板", exact: true })
        .click();
      await page.getByRole("option", { name: preset, exact: true }).click();
      await page
        .getByRole("button", { name: "创建并编辑", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "编辑订阅配置", exact: true }),
      ).toBeVisible();
      ids.push(
        decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!),
      );
      const input = jsonEditor(page, "客户端基础配置 JSON");
      const json = JSON.parse(await input.value());
      json.log.level = level;
      await input.fill(JSON.stringify(json));
      await page.getByRole("button", { name: "保存草稿", exact: true }).click();
      await expect(
        page.getByText("草稿已保存，客户端仍使用已发布配置。", { exact: true }),
      ).toBeVisible();
      await page.reload();
      expect(await input.value()).toBe(JSON.stringify(json));
      await page
        .getByRole("button", { name: "节点组与属性", exact: true })
        .click();
      await page
        .getByLabel("select-ai · 地区", { exact: true })
        .fill("日本, 新加坡");
      await page
        .getByLabel("auto-ai · 地区", { exact: true })
        .fill("日本, 新加坡");
      await page.getByRole("button", { name: "生成预览", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "订阅配置预览", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "发布此订阅", exact: true })
        .click();
      await expect(
        page.getByText(
          "订阅配置已发布。链接保持不变，客户端下次更新订阅时获取新规则；其他订阅不受影响。",
          { exact: true },
        ),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "返回订阅列表", exact: true })
        .click();
    }
    const profiles = await Promise.all(
      ids.map(
        async (id) =>
          (
            await rpc<{ profile: { url: string } }>(
              page.request,
              app.origin,
              "bifurcation.panel.v1.MeService/GetSubscriptionProfile",
              { id },
            )
          ).body.profile,
      ),
    );
    expect(profiles[0].url).not.toBe(profiles[1].url);
    const configs = await Promise.all(
      profiles.map(async (profile) =>
        (await page.request.get(profile.url)).json(),
      ),
    );
    expect(configs[0].log.level).toBe("debug");
    expect(configs[1].log.level).toBe("warn");
    const managed = (value: { outbounds: { tag: string }[] }) =>
      value.outbounds.filter((entry) => entry.tag.startsWith("bfc_"));
    expect(managed(configs[0])).toEqual(managed(configs[1]));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("denied");
          },
        },
      }),
    );
    const phone = page
      .getByRole("row")
      .filter({
        has: page.getByRole("link", { name: "手机规则", exact: true }),
      });
    await phone.getByRole("button", { name: "复制链接", exact: true }).click();
    await expect(page.getByLabel("完整订阅链接", { exact: true })).toHaveValue(
      profiles[1].url,
    );
    await expect(page.getByLabel("完整订阅链接", { exact: true })).toHaveCount(
      1,
    );
    await page.keyboard.press("Escape");
    await phone.getByRole("button", { name: "手机规则 的更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "暂停订阅", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "暂停订阅", exact: true })
      .click();
    await expect(phone.getByText("已暂停", { exact: true })).toBeVisible();
    expect((await page.request.get(profiles[1].url)).status()).toBe(403);
    expect((await page.request.get(profiles[0].url)).status()).toBe(200);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await peer.close();
  }
});
