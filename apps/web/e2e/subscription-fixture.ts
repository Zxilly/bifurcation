import { expect, type APIRequestContext } from "@playwright/test";
import { connectMachine } from "./machine-fixture";
import { rpc } from "./rpc";

// A ready protocol peer for subscription UI tests; it does not run sing-box.
export async function readySubscriptionNode(request: APIRequestContext, origin: string, name: string, region: string) {
  const created = await rpc<{ machine: { id: string; token: string } }>(request, origin, "bifurcation.panel.v1.AdminMachineService/CreateMachine", { name, address: "node.test", region });
  expect(created.status).toBe(200);
  const peer = await connectMachine(origin, created.body.machine.token);
  try {
    const service = "bifurcation.panel.v1.AdminConfigurationService";
    const preview = await rpc<{ preview: { previewId: string } }>(request, origin, `${service}/PreviewConfiguration`, {
      machineId: created.body.machine.id, expectedVersion: 0,
      settings: { listen: "::", trojanPort: 443, hysteria2Port: 8443, tls: { serverName: "node.test", path: { certificatePath: "/test/cert.pem", privateKeyPath: "/test/key.pem" } } },
    });
    expect(preview.status).toBe(200);
    const published = await rpc<{ revisionId: string; task: { id: string } }>(request, origin, `${service}/PublishConfiguration`, {
      machineId: created.body.machine.id, expectedVersion: 0, previewId: preview.body.preview.previewId, requestKey: crypto.randomUUID(),
    });
    expect(published.status).toBe(200);
    const task = await peer.nextTask(published.body.task.id);
    await peer.call("AcceptTask", { sessionEpoch: peer.session.sessionEpoch, taskId: task.taskId, payloadSha256: task.payloadSha256 });
    const config = await peer.call<{ policyRevision: string; configSha256: string }>("GetConfig", { revisionId: published.body.revisionId });
    await peer.call("ReportStatus", {
      sessionEpoch: peer.session.sessionEpoch, sequence: "1",
      status: { observedAtUnixMs: String(Date.now()), daemonVersion: "test", coreVersion: "1.14.0", coreHealth: "CORE_HEALTH_HEALTHY", appliedRevisionId: published.body.revisionId, appliedPolicyRevision: config.policyRevision, appliedConfigSha256: config.configSha256 },
    });
    return { id: created.body.machine.id, peer };
  } catch (error) {
    await peer.close();
    throw error;
  }
}
