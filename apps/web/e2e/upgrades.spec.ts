import { randomUUID } from "node:crypto";
import { test, expect, activate } from "./fixtures";
import { connectMachine } from "./machine-fixture";
import { rpc } from "./rpc";

test("daemon upgrade owns the embedded core lifecycle, rollback, reconnect and uninstall", async ({
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
    { name: "Upgrade fixture", address: "192.0.2.30", region: "东京" },
  );
  expect(created.status).toBe(200);
  const { machine } = created.body;
  let peer = await connectMachine(app.origin, machine.token, {
    daemonVersion: "0.1.0",
    supportedTasks: [1, 3, 5, 6],
  });
  try {
    const status = {
      observedAtUnixMs: String(Date.now()),
      daemonVersion: "0.1.0",
      coreVersion: "1.14.0",
      coreHealth: "CORE_HEALTH_NOT_CONFIGURED",
    };
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch,
      sequence: "1",
      status,
    });
    const preview = await rpc<{ preview: { previewId: string } }>(
      page.request,
      app.origin,
      "bifurcation.panel.v1.AdminConfigurationService/PreviewConfiguration",
      {
        machineId: machine.id,
        expectedVersion: 0,
        settings: {
          trojanPort: 443,
          hysteria2Port: 8443,
          tls: {
            serverName: "node.test",
            path: {
              certificatePath: "/etc/fixture/fullchain.pem",
              privateKeyPath: "/etc/fixture/privkey.pem",
            },
          },
          baseJson: {},
        },
      },
    );
    expect(preview.status).toBe(200);
    const { previewId } = preview.body.preview;
    const published = await rpc<{ revisionId: string }>(
      page.request,
      app.origin,
      "bifurcation.panel.v1.AdminConfigurationService/PublishConfiguration",
      {
        machineId: machine.id,
        previewId,
        expectedVersion: 0,
        requestKey: randomUUID(),
      },
    );
    expect(published.status).toBe(200);
    const { revisionId } = published.body;
    const configurationTask = await peer.nextTask();
    await peer.call("AcceptTask", {
      sessionEpoch: peer.session.sessionEpoch,
      taskId: configurationTask.taskId,
      payloadSha256: configurationTask.payloadSha256,
    });
    const { policyRevision, configSha256 } = await peer.call<{
      policyRevision: string;
      configSha256: string;
    }>("GetConfig", { revisionId });
    await peer.call("ReportTask", {
      taskId: configurationTask.taskId,
      payloadSha256: configurationTask.payloadSha256,
      sequence: "1",
      state: "TASK_STATE_SUCCEEDED",
      phase: "completed",
      message: "Embedded configuration fixture ready",
    });
    const appliedStatus = {
      ...status,
      coreHealth: "CORE_HEALTH_HEALTHY",
      coreRuntimeId: "embedded-fixture-runtime",
      appliedRevisionId: revisionId,
      appliedPolicyRevision: policyRevision,
      appliedConfigSha256: configSha256,
    };
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch,
      sequence: "2",
      status: appliedStatus,
    });
    await page.goto(`${app.origin}/admin/machines/${machine.id}`);
    await expect(
      page.getByRole("button", {
        name: /升级核心|重新安装核心|配置并安装核心/,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByText("携带 sing-box", { exact: true }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "升级 daemon", exact: true })
      .click();
    await expect(
      page.getByText("代理连接会中断", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "daemon 重启会同时重启内嵌 sing-box，代理连接与管理连接都会暂时中断。",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "开始升级", exact: true }).click();
    await expect(
      page.getByText("升级 daemon 任务已排队。", { exact: true }),
    ).toBeVisible();
    const rollbackTask = await peer.nextTask();
    expect(rollbackTask.kind).toBe("TASK_KIND_UPGRADE_DAEMON");
    await peer.call("AcceptTask", {
      sessionEpoch: peer.session.sessionEpoch,
      taskId: rollbackTask.taskId,
      payloadSha256: rollbackTask.payloadSha256,
    });
    await peer.call("ReportTask", {
      taskId: rollbackTask.taskId,
      payloadSha256: rollbackTask.payloadSha256,
      sequence: "1",
      state: "TASK_STATE_RUNNING",
      phase: "downloading",
      progressPercent: 25,
      message: "Downloading daemon fixture",
    });
    await page.reload();
    await expect(
      page.getByRole("progressbar", { name: "升级 daemon进度", exact: true }),
    ).toHaveAttribute("value", "25");
    await peer.call("ReportTask", {
      taskId: rollbackTask.taskId,
      payloadSha256: rollbackTask.payloadSha256,
      sequence: "2",
      state: "TASK_STATE_FAILED",
      phase: "rolled_back",
      rollback: "ROLLBACK_STATE_SUCCEEDED",
      errorCode: "FIXTURE_START_FAILED",
      message: "Protocol fixture reported daemon rollback",
    });
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "进行中的任务", exact: true }),
    ).toHaveCount(0);
    const failedHistory = page
      .getByRole("row")
      .filter({
        has: page.getByRole("cell", { name: "升级 daemon", exact: true }),
      })
      .filter({ has: page.getByRole("cell", { name: "失败", exact: true }) });
    await failedHistory.getByText("查看详情", { exact: true }).click();
    await expect(
      failedHistory.getByText("机器已报告回滚成功。", { exact: true }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "升级 daemon", exact: true })
      .click();
    await app.replaceDaemonArtifact();
    await page.getByRole("button", { name: "开始升级", exact: true }).click();
    await expect(
      page.getByText("候选制品已更新，请刷新后重新确认版本与 SHA-256。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "开始升级", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "刷新候选版本", exact: true })
      .click();
    const upgradeResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/machines/${machine.id}/upgrades`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "开始升级", exact: true }).click();
    expect((await upgradeResponse).request().postDataJSON()).toEqual({
      expectedSha256: expect.any(String),
      requestKey: expect.any(String),
    });
    await expect(
      page.getByText("升级 daemon 任务已排队。", { exact: true }),
    ).toBeVisible();
    const daemonTask = await peer.nextTask();
    expect(daemonTask.kind).toBe("TASK_KIND_UPGRADE_DAEMON");
    await peer.call("AcceptTask", {
      sessionEpoch: peer.session.sessionEpoch,
      taskId: daemonTask.taskId,
      payloadSha256: daemonTask.payloadSha256,
    });
    await peer.call("ReportTask", {
      taskId: daemonTask.taskId,
      payloadSha256: daemonTask.payloadSha256,
      sequence: "1",
      state: "TASK_STATE_RUNNING",
      phase: "updater_ready",
      progressPercent: 50,
      message: "Protocol fixture handed off to updater",
    });
    await page.reload();
    await expect(
      page.getByText("更新器已接手，等待执行结果。", { exact: true }),
    ).toBeVisible();
    const information = page.locator("section").filter({
      has: page.getByRole("heading", { name: "机器信息", exact: true }),
    });
    await expect(information.getByText("0.1.0", { exact: true })).toBeVisible();
    const installation = peer.installation;
    await peer.close();
    await page.reload();
    await expect(
      page.getByText("等待机器重连和执行结果，尚未确认升级是否完成。", {
        exact: true,
      }),
    ).toBeVisible();
    peer = await connectMachine(app.origin, machine.token, {
      installation,
      daemonVersion: "0.2.0",
      supportedTasks: [1, 3, 5, 6],
    });
    const completedDaemon = {
      taskId: daemonTask.taskId,
      payloadSha256: daemonTask.payloadSha256,
      sequence: "2",
      state: "TASK_STATE_SUCCEEDED",
      phase: "completed",
      rollback: "ROLLBACK_STATE_NOT_NEEDED",
      message: "Protocol fixture confirmed daemon 0.2.0",
      actualStatus: {
        ...appliedStatus,
        observedAtUnixMs: String(Date.now()),
        daemonVersion: "0.2.0",
      },
    };
    await expect(peer.call("ReportTask", completedDaemon)).rejects.toThrow(
      "WAITING_FOR_DAEMON_RECONNECT",
    );
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch,
      sequence: "1",
      status: {
        ...appliedStatus,
        observedAtUnixMs: String(Date.now()),
        daemonVersion: "0.2.0",
      },
    });
    await peer.call("ReportTask", completedDaemon);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "进行中的任务", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("更新器已接手，等待执行结果。", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "升级 daemon", exact: true }),
    ).toBeDisabled();
    await expect(information.getByText("0.2.0", { exact: true })).toBeVisible();
    const daemonHistory = page
      .getByRole("row")
      .filter({
        has: page.getByRole("cell", { name: "升级 daemon", exact: true }),
      })
      .filter({ has: page.getByRole("cell", { name: "已完成", exact: true }) });
    await daemonHistory.getByText("查看详情", { exact: true }).click();
    await expect(
      daemonHistory.getByText("Protocol fixture confirmed daemon 0.2.0", {
        exact: true,
      }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.body.scrollWidth <= innerWidth),
    ).toBe(true);

    await page
      .getByRole("button", { name: "卸载节点程序", exact: true })
      .click();
    await expect(
      page.getByText(/daemon 及其内嵌核心，代理连接会中断/),
    ).toBeVisible();
    const uninstallResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/machines/${machine.id}/uninstall`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "开始卸载", exact: true }).click();
    const uninstallRequest = await uninstallResponse;
    expect(uninstallRequest.request().postDataJSON()).toEqual({
      requestKey: expect.any(String),
    });
    const uninstallResult = (await uninstallRequest.json()) as {
      task: { id: string };
    };
    await expect(
      page.getByText("卸载任务已排队，请等待机器回报结果。", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "移除记录", exact: true }),
    ).toBeDisabled();
    const uninstallTask = await peer.nextTask(uninstallResult.task.id);
    expect(uninstallTask.kind).toBe("TASK_KIND_UNINSTALL");
    await peer.call("AcceptTask", {
      sessionEpoch: peer.session.sessionEpoch,
      taskId: uninstallTask.taskId,
      payloadSha256: uninstallTask.payloadSha256,
    });
    await peer.call("ReportTask", {
      taskId: uninstallTask.taskId,
      payloadSha256: uninstallTask.payloadSha256,
      sequence: "1",
      state: "TASK_STATE_SUCCEEDED",
      phase: "uninstalled",
      message: "Protocol fixture reported daemon and embedded core removed",
    });
    await page.reload();
    await expect(
      page.getByText("节点已报告卸载完成，可继续移除面板记录。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "机器 Token", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "安装与重装命令", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "重新接入", exact: true }),
    ).toBeEnabled();
    const subscriptionAfterUninstall = (
      await rpc<{ subscription: { nodes: { machineId: string }[] } }>(
        page.request,
        app.origin,
        "bifurcation.panel.v1.MeService/GetSubscription",
      )
    ).body.subscription;
    expect(
      subscriptionAfterUninstall.nodes.some(
        (node) => node.machineId === machine.id,
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "移除记录", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "移除记录", exact: true })
      .click();
    await expect(page).toHaveURL(`${app.origin}/admin/machines`);
    expect(
      (
        await rpc(page.request, app.origin, "bifurcation.panel.v1.AdminMachineService/GetMachine", {
          machineId: machine.id,
        })
      ).status,
    ).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    await peer.close();
  }
});
