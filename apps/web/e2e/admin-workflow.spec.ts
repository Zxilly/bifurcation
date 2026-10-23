import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { connectMachine } from "./machine-fixture";
import { jsonEditor } from "./json-editor";
import { rpc } from "./rpc";

const configurationService = "bifurcation.panel.v1.AdminConfigurationService";
type Publication = { revisionId: string; version: number; task: { id: string } };

test.use({ initializeAdmin: false });

async function setup(page: Page, app: { origin: string; username: string; password: string }) {
  await page.goto(app.origin);
  await page.getByLabel("用户名", { exact: true }).fill(app.username);
  await page.getByLabel("后备密码", { exact: true }).fill(app.password);
  await page.getByLabel("确认后备密码", { exact: true }).fill(app.password);
  await page.getByRole("button", { name: "创建管理员并进入", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/admin`);
}

async function publish(page: Page): Promise<Publication> {
  const response = page.waitForResponse((response) =>
    response.url().endsWith(`/${configurationService}/PublishConfiguration`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "检查并发布", exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  return result.json();
}

test("administrator completes setup, enrollment, failed publication recovery and invitation from actionable next steps", async ({ page, app }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await setup(page, app);
  await expect(page.getByRole("heading", { name: "接入第一台机器", exact: true })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole("link", { name: "添加第一台机器", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "添加机器", exact: true });
  await expect(createDialog).toBeVisible();
  await createDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/admin/machines`);
  await page.getByRole("button", { name: "添加机器", exact: true }).click();
  await createDialog.getByLabel("名称", { exact: true }).fill("Tokyo first node");
  await createDialog.getByLabel("地址", { exact: true }).fill("192.0.2.32");
  await createDialog.getByRole("button", { name: "创建机器", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/machines\/[^/?]+$/);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const detail = await rpc<{ machine: { token: string } }>(page.request, app.origin,
    "bifurcation.panel.v1.AdminMachineService/GetMachine", { machineId: id });
  expect(detail.status).toBe(200);
  await page.goto(`${app.origin}/admin`);
  await page.getByRole("link", { name: "查看安装命令", exact: true }).click();
  await expect(page).toHaveURL(`${app.origin}/admin/machines/${id}?tab=maintenance`);
  await expect(page.getByRole("tab", { name: "接入与维护", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("link", { name: "发布配置", exact: true }).click();
  await expect(page.getByText("先接入机器，再发布配置", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "查看安装命令", exact: true })).toBeVisible();
  await expect(page.getByText("可以先填写并预览配置。发布需要在 Linux 机器上执行安装命令，等待节点接入。", { exact: true })).toBeVisible();
  await expect(page.locator(".json-editor-host")).toHaveCount(0);
  await page.getByLabel("TLS 服务器名称", { exact: true }).fill("node.example.test");
  await page.getByLabel("Trojan 监听端口", { exact: true }).fill("4443");
  await page.getByText("高级基础配置（可选）", { exact: false }).click();
  await jsonEditor(page, "基础配置 JSON").fill('{"log":{"level":"debug"}}');
  const peer = await connectMachine(app.origin, detail.body.machine.token);
  try {
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch, sequence: "1",
      status: { observedAtUnixMs: String(Date.now()), daemonVersion: "e2e-protocol-peer", coreVersion: "1.14.0", coreHealth: "CORE_HEALTH_NOT_CONFIGURED" },
    });
    await expect(page.getByText("先接入机器，再发布配置", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "生成预览", exact: true }).click();
    const first = await publish(page);
    const task = await peer.nextTask(first.task.id);
    await peer.call("AcceptTask", { sessionEpoch: peer.session.sessionEpoch, taskId: task.taskId, payloadSha256: task.payloadSha256 });
    await peer.call("ReportTask", { taskId: task.taskId, payloadSha256: task.payloadSha256, sequence: "1", state: "TASK_STATE_RUNNING", progressPercent: 35, message: "正在检查测试配置" });
    await expect(page.getByRole("heading", { name: "节点正在检查并应用配置", exact: true })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "配置应用进度", exact: true })).toHaveAttribute("value", "35");
    await peer.call("ReportTask", { taskId: task.taskId, payloadSha256: task.payloadSha256, sequence: "2", state: "TASK_STATE_FAILED", errorCode: "CERTIFICATE_NOT_FOUND", message: "证书文件不存在，请检查 TLS 证书路径" });
    await expect(page.getByRole("heading", { name: "配置应用失败", exact: true })).toBeVisible();
    await expect(page.getByText("证书文件不存在，请检查 TLS 证书路径", { exact: true })).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.getByRole("button", { name: "返回修改并重试", exact: true }).click();
    await expect(page.getByLabel("TLS 服务器名称", { exact: true })).toHaveValue("node.example.test");
    await expect(page.getByLabel("Trojan 监听端口", { exact: true })).toHaveValue("4443");
    expect(JSON.parse(await jsonEditor(page, "基础配置 JSON").value())).toEqual({ log: { level: "debug" } });
    await expect(page.getByRole("button", { name: "检查并发布", exact: true })).toHaveCount(0);
    await page.getByLabel("TLS 证书路径", { exact: true }).fill("/etc/ssl/correct.pem");
    await page.getByRole("button", { name: "生成预览", exact: true }).click();
    const second = await publish(page);
    const retry = await peer.nextTask(second.task.id);
    await peer.call("AcceptTask", { sessionEpoch: peer.session.sessionEpoch, taskId: retry.taskId, payloadSha256: retry.payloadSha256 });
    const config = await peer.call<{ policyRevision: string; configSha256: string }>("GetConfig", { revisionId: second.revisionId });
    await peer.call("ReportTask", { taskId: retry.taskId, payloadSha256: retry.payloadSha256, sequence: "1", state: "TASK_STATE_SUCCEEDED", message: "测试任务已完成" });
    await expect(page.getByRole("heading", { name: "等待节点确认生效", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "节点已确认应用配置", exact: true })).toHaveCount(0);
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch, sequence: "2",
      status: { observedAtUnixMs: String(Date.now()), daemonVersion: "e2e-protocol-peer", coreVersion: "1.14.0", coreHealth: "CORE_HEALTH_HEALTHY", appliedRevisionId: second.revisionId, appliedPolicyRevision: config.policyRevision, appliedConfigSha256: config.configSha256 },
    });
    await expect(page.getByRole("heading", { name: "节点已确认应用配置", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "邀请用户", exact: true }).click();
    const invitation = page.getByRole("dialog", { name: "创建用户", exact: true });
    await expect(invitation).toBeVisible();
    await invitation.getByLabel("用户名", { exact: true }).fill("friend-one");
    await invitation.getByRole("button", { name: "创建用户", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "用户已创建", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await expect(page).toHaveURL(`${app.origin}/admin/users`);
    await page.getByRole("row").filter({ hasText: "friend-one" }).getByRole("button", { name: "编辑", exact: true }).click();
    await page.getByRole("dialog", { name: "编辑用户", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
    // Next's native history integration retains this client component. A new
    // create deep link must take precedence over its previous edit action.
    await page.evaluate(() => window.history.pushState(null, "", "?action=create"));
    await expect(page.getByRole("dialog", { name: "创建用户", exact: true })).toBeVisible();
    await page.getByRole("dialog", { name: "创建用户", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
    await page.goto(`${app.origin}/admin`);
    await expect(page.getByRole("heading", { name: "1 位用户等待激活", exact: true })).toBeVisible();
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch, sequence: "3",
      status: { observedAtUnixMs: String(Date.now()), daemonVersion: "e2e-protocol-peer", coreVersion: "1.14.0", coreHealth: "CORE_HEALTH_UNHEALTHY", appliedRevisionId: second.revisionId, appliedPolicyRevision: config.policyRevision, appliedConfigSha256: config.configSha256 },
    });
    await page.reload();
    await page.getByRole("link", { name: "查看操作与日志", exact: true }).click();
    await expect(page).toHaveURL(`${app.origin}/admin/machines/${id}?tab=activity`);
    await expect(page.getByRole("tab", { name: "操作记录", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(errors).toEqual([]);
  } finally { await peer.close(); }
});

test("publication progress stays attached to its receipt when another administrator publishes a newer revision", async ({ page, app }) => {
  await setup(page, app);
  const created = await rpc<{ machine: { id: string; token: string } }>(page.request, app.origin,
    "bifurcation.panel.v1.AdminMachineService/CreateMachine", { name: "Concurrent configuration", address: "192.0.2.33" });
  expect(created.status).toBe(200);
  const { machine } = created.body;
  const peer = await connectMachine(app.origin, machine.token);
  try {
    await page.goto(`${app.origin}/admin/machines/${machine.id}/configuration`);
    await page.getByLabel("TLS 服务器名称", { exact: true }).fill("first.example.test");
    await page.getByRole("button", { name: "生成预览", exact: true }).click();
    const first = await publish(page);
    const firstTask = await peer.nextTask(first.task.id);
    await peer.call("AcceptTask", { sessionEpoch: peer.session.sessionEpoch, taskId: firstTask.taskId, payloadSha256: firstTask.payloadSha256 });
    const preview = await rpc<{ preview: { previewId: string } }>(page.request, app.origin, `${configurationService}/PreviewConfiguration`, {
      machineId: machine.id, expectedVersion: first.version,
      settings: { listen: "::", trojanPort: 9443, hysteria2Port: 8443, tls: { serverName: "newer.example.test", path: { certificatePath: "/etc/ssl/new.pem", privateKeyPath: "/etc/ssl/new.key" } }, baseJson: {} },
    });
    expect(preview.status).toBe(200);
    const newer = await rpc<Publication>(page.request, app.origin, `${configurationService}/PublishConfiguration`, { machineId: machine.id, expectedVersion: first.version, previewId: preview.body.preview.previewId, requestKey: crypto.randomUUID() });
    expect(newer.status).toBe(200);
    await peer.call("ReportTask", { taskId: firstTask.taskId, payloadSha256: firstTask.payloadSha256, sequence: "1", state: "TASK_STATE_SUCCEEDED" });
    const newerTask = await peer.nextTask(newer.body.task.id);
    await peer.call("AcceptTask", { sessionEpoch: peer.session.sessionEpoch, taskId: newerTask.taskId, payloadSha256: newerTask.payloadSha256 });
    const config = await peer.call<{ policyRevision: string; configSha256: string }>("GetConfig", { revisionId: newer.body.revisionId });
    await peer.call("ReportTask", { taskId: newerTask.taskId, payloadSha256: newerTask.payloadSha256, sequence: "1", state: "TASK_STATE_SUCCEEDED" });
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch, sequence: "1",
      status: { observedAtUnixMs: String(Date.now()), daemonVersion: "e2e-protocol-peer", coreVersion: "1.14.0", coreHealth: "CORE_HEALTH_HEALTHY", appliedRevisionId: newer.body.revisionId, appliedPolicyRevision: config.policyRevision, appliedConfigSha256: config.configSha256 },
    });
    await expect(page.getByRole("heading", { name: "已有更新的配置发布", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "节点已确认应用配置", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "编辑最新配置", exact: true }).click();
    await expect(page.getByLabel("TLS 服务器名称", { exact: true })).toHaveValue("newer.example.test");
    await expect(page.getByLabel("Trojan 监听端口", { exact: true })).toHaveValue("9443");
  } finally { await peer.close(); }
});
