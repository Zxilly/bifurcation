import { createHash, randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { UsageBatchSchema } from "@bifurcation/rpc";
import { test, expect, activate } from "./fixtures";
import { connectMachine } from "./machine-fixture";
import { rpc } from "./rpc";

type SubscriptionBody = { subscription: { url: string; credentialGeneration: number } };

function getSubscription(request: Parameters<typeof rpc>[0], origin: string) {
  return rpc<SubscriptionBody>(request, origin, "bifurcation.panel.v1.MeService/GetSubscription");
}

test("configuration preview and publish, independent subscription resets, and real usage query charts", async ({
  page,
  app,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await activate(page, app);
  const me = (
    await rpc<{ user: { id: string } }>(
      page.request,
      app.origin,
      "bifurcation.panel.v1.MeService/GetMe",
    )
  ).body;
  const created = await rpc<{ machine: { id: string; token: string } }>(
    page.request,
    app.origin,
    "bifurcation.panel.v1.AdminMachineService/CreateMachine",
    { name: "Traffic fixture", address: "192.0.2.20", region: "东京" },
  );
  expect(created.status).toBe(200);
  const { machine } = created.body;
  const peer = await connectMachine(app.origin, machine.token);
  try {
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch,
      sequence: "1",
      status: {
        observedAtUnixMs: String(Date.now()),
        daemonVersion: "e2e-protocol-peer",
        coreVersion: "1.14.0",
        coreRuntimeId: "fixture-runtime",
        coreHealth: "CORE_HEALTH_NOT_CONFIGURED",
        cpuUsagePercent: 2.5,
        memoryUsedBytes: "104857600",
        memoryTotalBytes: "1073741824",
      },
    });
    await page.goto(`${app.origin}/admin/machines/${machine.id}`);
    await page.getByRole("button", { name: "发布配置", exact: true }).click();
    await page.getByLabel("TLS 服务器名称", { exact: true }).fill("node.test");
    await page
      .getByLabel("基础配置 JSON", { exact: true })
      .fill('{"log":{"level":"debug"},"inbounds":[]}');
    await page.getByRole("button", { name: "生成预览", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "最终 sing-box JSON", exact: true }),
    ).toHaveCount(0);
    await page
      .getByLabel("基础配置 JSON", { exact: true })
      .fill('{"log":{"level":"debug"}}');
    await page.getByRole("button", { name: "生成预览", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "最终 sing-box JSON", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "最终 sing-box JSON", exact: true }),
    ).toBeFocused();
    const preview = JSON.parse(
      await page.getByLabel("sing-box JSON", { exact: true }).innerText(),
    ) as {
      log: { level: string };
      inbounds: { type: string; listen_port: number }[];
    };
    expect(preview.log.level).toBe("debug");
    expect(
      preview.inbounds.some(
        (inbound) => inbound.type === "trojan" && inbound.listen_port === 443,
      ),
    ).toBe(true);
    // Editing after preview must hide the publish action until a fresh preview.
    await page.getByLabel("Trojan 监听端口", { exact: true }).fill("4443");
    await expect(
      page.getByRole("button", { name: "检查并发布", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "生成预览", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "最终 sing-box JSON", exact: true }),
    ).toBeVisible();
    const publishedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/bifurcation.panel.v1.AdminConfigurationService/PublishConfiguration") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "检查并发布", exact: true }).click();
    const published = (await (await publishedResponse).json()) as {
      revisionId: string;
      task: { id: string };
    };
    await expect(
      page.getByText("配置已发布，等待机器完成检查和应用。", { exact: true }),
    ).toBeVisible();
    const task = await peer.nextTask();
    expect(task.taskId).toBe(published.task.id);
    await peer.call("AcceptTask", {
      sessionEpoch: peer.session.sessionEpoch,
      taskId: task.taskId,
      payloadSha256: task.payloadSha256,
    });
    const config = await peer.call<{
      policyRevision: string;
      configJson: string;
      configSha256: string;
    }>("GetConfig", { revisionId: published.revisionId });
    expect(
      createHash("sha256")
        .update(Buffer.from(config.configJson, "base64"))
        .digest("hex"),
    ).toBe(config.configSha256);
    const applied = JSON.parse(
      Buffer.from(config.configJson, "base64").toString("utf8"),
    ) as { inbounds: { type: string; listen_port: number }[] };
    expect(
      applied.inbounds.some(
        (inbound) => inbound.type === "trojan" && inbound.listen_port === 4443,
      ),
    ).toBe(true);
    await peer.call("ReportTask", {
      taskId: task.taskId,
      payloadSha256: task.payloadSha256,
      sequence: "1",
      state: "TASK_STATE_SUCCEEDED",
      phase: "complete",
      message: "Protocol fixture applied configuration",
      actualStatus: {
        observedAtUnixMs: String(Date.now()),
        daemonVersion: "e2e-protocol-peer",
        coreVersion: "1.14.0",
        coreRuntimeId: "fixture-runtime",
        coreHealth: "CORE_HEALTH_HEALTHY",
        appliedRevisionId: published.revisionId,
        appliedPolicyRevision: config.policyRevision,
        appliedConfigSha256: config.configSha256,
      },
    });
    // Machine state is independently fenced by the active session/status sequence.
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch,
      sequence: "2",
      status: {
        observedAtUnixMs: String(Date.now()),
        daemonVersion: "e2e-protocol-peer",
        coreVersion: "1.14.0",
        coreRuntimeId: "fixture-runtime",
        coreHealth: "CORE_HEALTH_HEALTHY",
        appliedRevisionId: published.revisionId,
        appliedPolicyRevision: config.policyRevision,
        appliedConfigSha256: config.configSha256,
      },
    });
    await page.reload();
    await expect(page.getByText("已同步", { exact: true })).toBeVisible();
    const diagnosticResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/bifurcation.panel.v1.AdminMachineService/EnqueueInspectTask") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "获取最近 100 行日志", exact: true })
      .click();
    const diagnosticRequest = await diagnosticResponse;
    expect(diagnosticRequest.request().postDataJSON()).toMatchObject({
      machineId: machine.id,
      includeLogs: true,
      maxLogLines: 100,
      maxBytes: 65_536,
    });
    const diagnosticResult = (await diagnosticRequest.json()) as {
      task: { id: string };
    };
    const inspectTask = await peer.nextTask(diagnosticResult.task.id);
    await peer.call("AcceptTask", {
      sessionEpoch: peer.session.sessionEpoch,
      taskId: inspectTask.taskId,
      payloadSha256: inspectTask.payloadSha256,
    });
    const logText = "fixture <script>window.__logInjected=true</script>";
    await peer.call("ReportTask", {
      taskId: inspectTask.taskId,
      payloadSha256: inspectTask.payloadSha256,
      sequence: "1",
      state: "TASK_STATE_SUCCEEDED",
      phase: "completed",
      diagnosticJson: Buffer.from(
        JSON.stringify({
          hostname: "fixture-host",
          observedAt: Date.now(),
          logs: {
            source: "embedded-core",
            lines: ["fixture connection accepted", logText],
            truncated: true,
          },
        }),
      ).toString("base64"),
    });
    await page.reload();
    const diagnosticHistory = page.getByRole("row").filter({
      has: page.getByRole("cell", { name: "运行信息与日志", exact: true }),
    });
    await diagnosticHistory.getByText("查看详情", { exact: true }).click();
    await expect(page.getByLabel("最近日志", { exact: true })).toContainText(
      logText,
    );
    await expect(
      page.getByText("日志内容因行数或大小限制被截断。", { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => "__logInjected" in window)).toBe(false);

    await page.goto(`${app.origin}/subscription`);
    await expect(
      page.getByRole("cell", { name: "Traffic fixture", exact: true }),
    ).toBeVisible();
    const subscriptionBefore = (await getSubscription(page.request, app.origin)).body.subscription;
    await page
      .getByRole("button", { name: "重置订阅链接", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "重置订阅链接", exact: true })
      .click();
    await expect(
      page.getByText("订阅链接已重置，请更新客户端的订阅地址。", {
        exact: true,
      }),
    ).toBeVisible();
    const subscriptionAfter = (await getSubscription(page.request, app.origin)).body.subscription;
    expect(subscriptionAfter.url === subscriptionBefore.url).toBe(false);
    expect(subscriptionAfter.credentialGeneration).toBe(
      subscriptionBefore.credentialGeneration,
    );
    expect((await page.request.get(subscriptionBefore.url)).status()).toBe(404);
    await page
      .getByRole("button", { name: "重置代理凭据", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "重置代理凭据", exact: true })
      .click();
    await expect(
      page.getByText("代理凭据已重置，等待机器应用新配置。请重新获取订阅。", {
        exact: true,
      }),
    ).toBeVisible();
    const credentialsAfter = (await getSubscription(page.request, app.origin)).body.subscription;
    expect(credentialsAfter.url === subscriptionAfter.url).toBe(true);
    expect(credentialsAfter.credentialGeneration).toBeGreaterThan(
      subscriptionAfter.credentialGeneration,
    );

    const now = Date.now();
    const payload = toBinary(
      UsageBatchSchema,
      create(UsageBatchSchema, {
        coreRuntimeId: "fixture-runtime",
        deltas: [
          {
            userId: me.user.id,
            startUnixMs: BigInt(now - 5_000),
            endUnixMs: BigInt(now),
            uploadBytes: 1073741824n,
            downloadBytes: 2147483648n,
          },
        ],
      }),
    );
    const usageRequest = {
      streamId: randomBytes(16).toString("hex"),
      sequence: "1",
      payload: Buffer.from(payload).toString("base64"),
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
    };
    await peer.call("ReportUsage", usageRequest);
    await peer.call("ReportUsage", usageRequest);
    const usage = (await rpc<{ usage: { uploadBytes: string; downloadBytes: string } }>(page.request, app.origin, "bifurcation.panel.v1.MeService/GetMyUsage")).body.usage;
    expect(usage).toMatchObject({
      uploadBytes: "1073741824",
      downloadBytes: "2147483648",
    });
    await page.goto(`${app.origin}/overview`);
    await expect(
      page.getByText("3 GiB", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator("canvas")).toBeVisible();
    await expect(page.getByText("分钟平均峰值", { exact: true })).toBeVisible();
    await expect(
      page.getByText("当前周期未结束", { exact: true }),
    ).toBeVisible();
    const metricTops = await page
      .locator(".metric-row > .panel")
      .evaluateAll((panels) =>
        panels.map((panel) => Math.round(panel.getBoundingClientRect().top)),
      );
    expect(new Set(metricTops).size).toBe(1);
    await page.getByText("查看数值", { exact: true }).click();
    await expect(
      page.getByRole("cell", { name: "1 GiB", exact: true }).first(),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.getByLabel("时间范围", { exact: true }).selectOption("today");
    await expect(
      page.getByRole("heading", { name: "今天用了多少", exact: true }),
    ).toBeVisible();
    await expect(page.locator("canvas")).toBeVisible();
    await page.goto(`${app.origin}/admin/users`);
    await expect(
      page.getByRole("cell", { name: "Traffic fixture", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await peer.close();
  }
});
