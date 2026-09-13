import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { create, fromJsonString, toBinary } from "@bufbuild/protobuf";
import { CoreHealth, GetConfigRequestSchema, InstallationSchema, MachineStatusSchema, ReportTaskRequestSchema, ReportUsageRequestSchema, TaskKind, TaskState, UsageBatchSchema } from "@bifurcation/rpc";
import { openDatabase, type DatabaseHandle } from "@/server/db";
import { users } from "@/server/db/schema";
import { configRevisions, machineConfigs, machineUserHistory, policyState, usageBuckets, usageStreams } from "@/server/db/schema-proxy";
import { MachineStore } from "@/server/modules/machines/store";
import { ConfigurationStore } from "@/server/configuration/store";
import { PolicyStore } from "@/server/configuration/policy";
import { SubscriptionStore } from "@/server/subscription/store";
import { UsageStore } from "@/server/usage/store";
import { ReleaseStore } from "@/server/releases/store";
import { tasks } from "@/server/db/schema-machines";
import { initializeUserSecrets, readProxyCredentials } from "@/server/subscription/credentials";
import { jsonBytes, renderServer, validateSettings } from "@/server/adapters/sing-box";
import { newId, sha256 } from "@/server/crypto";
import { bucketStart, DAY_MS, monthStart, nextBucket } from "@/server/usage/time";

const certificatePem = readFileSync(new URL("./fixtures/test-server-cert.pem", import.meta.url), "utf8");
const privateKeyPem = readFileSync(new URL("./fixtures/test-server-key.pem", import.meta.url), "utf8");
// This certificate/private key pair is public test material for node.test only.
const settings = { listen: "127.0.0.1", trojanPort: 24443, hysteria2Port: 24444, tls: { mode: "pem" as const, serverName: "node.test", certificatePem, privateKeyPem }, baseJson: { log: { level: "warn" } } };

describe("configuration, subscription and exact usage accounting", () => {
  let directory: string;
  let database: DatabaseHandle;
  let configuration: ConfigurationStore;
  let machineStore: MachineStore;
  let usage: UsageStore;
  let adminId: string;
  let memberId: string;
  let machineId: string;
  beforeEach(() => {
    process.env.BIFURCATION_APP_KEY = "67".repeat(32);
    process.env.BIFURCATION_PUBLIC_URL = "http://localhost:3000";
    directory = mkdtempSync(join(tmpdir(), "bifurcation-proxy-"));
    database = openDatabase(join(directory, "panel.sqlite"));
    configuration = new ConfigurationStore(database); machineStore = new MachineStore(database); usage = new UsageStore(database);
    adminId = newId(); memberId = newId();
    for (const [id, username, role] of [[adminId, "admin", "admin"], [memberId, "member", "user"]] as const) {
      database.db.insert(users).values({ id, username, role, status: "active", createdAt: Date.now() }).run();
      initializeUserSecrets(id, database);
    }
    machineId = machineStore.create({ name: "Node", address: "node.test", region: "Test" }).id;
    machineStore.bind(machineId, create(InstallationSchema, { installationId: "test-installation-0001" }), { daemonVersion: "test", os: "linux", arch: "amd64", supportedTasks: [TaskKind.INSPECT, TaskKind.APPLY_CONFIG, TaskKind.UNINSTALL] });
  });
  afterEach(() => { database.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });
  function publish(confirmApplied = false) {
    const preview = configuration.preview(machineId, { expectedVersion: 0, settings }, adminId);
    const input = { previewId: preview.previewId, expectedVersion: 0, requestKey: newId() };
    const result = configuration.publish(machineId, input, adminId);
    if (confirmApplied) {
      const machine = machineStore.get(machineId);
      machineStore.reportStatus(machine, BigInt(machine.sessionEpoch), 1n, create(MachineStatusSchema, { observedAtUnixMs: BigInt(Date.now()), daemonVersion: "test", coreVersion: "1.14.0", coreHealth: CoreHealth.HEALTHY, appliedRevisionId: result.revisionId, appliedPolicyRevision: BigInt(preview.policyRevision) }));
    }
    return { preview, input, result };
  }
  function report(sequence: bigint, deltas: { userId: string; startUnixMs: bigint; endUnixMs: bigint; uploadBytes: bigint; downloadBytes: bigint; incomplete?: boolean }[]) {
    const payload = toBinary(UsageBatchSchema, create(UsageBatchSchema, { coreRuntimeId: "core-1", deltas }));
    return create(ReportUsageRequestSchema, { installation: { installationId: "test-installation-0001", bindingEpoch: 1n }, streamId: "usage-test-installation-0001", sequence, payload, payloadSha256: sha256(payload) });
  }

  it("publishes the exact preview atomically, retries the same task and isolates client credentials", () => {
    const { preview, input, result } = publish(true);
    expect(result.task.kind).toBe("apply_config");
    expect(configuration.publish(machineId, input, adminId)).toEqual(result);
    expect(database.db.select().from(configRevisions).all()).toHaveLength(1);
    const response = configuration.getConfig(machineId, create(GetConfigRequestSchema, { revisionId: result.revisionId }));
    expect(Buffer.from(response.configJson).toString("utf8")).toBe(preview.finalJson);
    expect(sha256(response.configJson)).toBe(response.configSha256);
    const client = new SubscriptionStore(database).get(memberId);
    const member = readProxyCredentials(memberId, database).secrets;
    const admin = readProxyCredentials(adminId, database).secrets;
    expect(client.configJson).toContain(member.trojanPassword);
    expect(client.configJson).toContain(member.hysteria2Password);
    expect(client.configJson).not.toContain(admin.trojanPassword);
    expect(client.configJson).not.toContain("PRIVATE KEY");
    expect(JSON.parse(client.configJson).outbounds.some((outbound: { type: string }) => outbound.type === "urltest")).toBe(true);
  });
  it("does not advertise an unstarted core and uses the actually applied settings while a new base is pending", () => {
    const { result, preview } = publish();
    const subscriptions = new SubscriptionStore(database);
    expect(subscriptions.get(memberId).nodes[0].available).toBe(false);
    expect(JSON.parse(subscriptions.get(memberId).configJson).route.rules).toEqual([{ action: "reject" }]);
    const current = machineStore.get(machineId);
    const applied = create(MachineStatusSchema, { observedAtUnixMs: BigInt(Date.now()), daemonVersion: "test", coreVersion: "1.14.0", coreHealth: CoreHealth.HEALTHY, appliedRevisionId: result.revisionId, appliedPolicyRevision: BigInt(preview.policyRevision) });
    machineStore.reportStatus(current, BigInt(current.sessionEpoch), 1n, applied);
    expect(subscriptions.get(memberId).nodes[0].available).toBe(true);
    const updated = configuration.preview(machineId, { expectedVersion: 1, settings: { ...settings, trojanPort: 25543 } }, adminId);
    const target = configuration.publish(machineId, { previewId: updated.previewId, expectedVersion: 1, requestKey: newId() }, adminId);
    const pending = subscriptions.get(memberId);
    expect(pending.nodes[0].configurationState).toBe("pending");
    expect(JSON.parse(pending.configJson).outbounds.find((entry: { type: string }) => entry.type === "trojan").server_port).toBe(24443);
    machineStore.reportStatus(machineStore.get(machineId), BigInt(current.sessionEpoch), 2n, { ...applied, coreHealth: CoreHealth.STOPPED });
    expect(subscriptions.get(memberId).nodes[0].available).toBe(false);
    machineStore.reportStatus(machineStore.get(machineId), BigInt(current.sessionEpoch), 3n, { ...applied, appliedRevisionId: target.revisionId });
    expect(JSON.parse(subscriptions.get(memberId).configJson).outbounds.find((entry: { type: string }) => entry.type === "trojan").server_port).toBe(25543);
  });
  it("publishes the embedded core configuration without a separate core artifact or control listener", () => {
    const { result, preview } = publish();
    expect(result.task.kind).toBe("apply_config");
    const rendered = JSON.parse(preview.finalJson);
    expect(rendered.services).toBeUndefined();
    expect(rendered.experimental).toBeUndefined();
    expect(rendered.inbounds.map((inbound: { type: string }) => inbound.type)).toEqual(["trojan", "hysteria2"]);
    expect(database.db.select().from(configRevisions).all()).toHaveLength(1);
  });
  it("keeps uninstall ACK credentials but stops subscription/config distribution, then restores approved settings only after explicit rebind", () => {
    publish(true);
    const machine = machineStore.get(machineId);
    const token = machineStore.detail(machineId).token;
    const task = new ReleaseStore(database).uninstall(machineId, { requestKey: newId() }).task;
    const journal = database.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    machineStore.accept(machine, BigInt(machine.sessionEpoch), task.id, journal.payloadHash);
    const report = create(ReportTaskRequestSchema, { installation: { installationId: machine.installationId!, bindingEpoch: BigInt(machine.bindingEpoch) }, taskId: task.id, payloadSha256: journal.payloadHash, sequence: 1n, state: TaskState.SUCCEEDED, phase: "uninstalled" });
    expect(machineStore.reportTask(machine, report).terminal).toBe(true);
    expect(machineStore.authenticate(`Bearer ${token}`).id).toBe(machineId);
    expect(machineStore.reportTask(machine, report).terminal).toBe(true);
    expect(new SubscriptionStore(database).get(memberId).nodes).toEqual([]);
    expect(() => configuration.getConfig(machineId, create(GetConfigRequestSchema, { authorizationOnly: true }))).toThrow("不能获取新的代理凭据");
    expect(configuration.reconcile()).toEqual([]);
    database.db.transaction(() => {
      machineStore.rebind(machineId, machineStore.get(machineId).version);
      configuration.markForRebind(machineId);
    });
    expect(machineStore.isUninstalled(machineId)).toBe(false);
    expect(configuration.get(machineId).latestTask).toBeNull();
    expect(machineStore.listTasks(machineId).some((record) => record.id === task.id)).toBe(true);
    const rebound = machineStore.bind(machineId, create(InstallationSchema, { installationId: "replacement-installation-0002" }), { daemonVersion: "test", os: "linux", arch: "amd64", supportedTasks: [TaskKind.APPLY_CONFIG] });
    expect(rebound.bindingEpoch).toBe(2);
    expect(configuration.reconcile()).toEqual([machineId]);
    expect(configuration.get(machineId).latestTask?.kind).toBe("apply_config");
    expect(configuration.get(machineId).settings?.trojanPort).toBe(settings.trojanPort);
  });
  it("keeps subscription and proxy rotations independent, retaining latest authorization on old revisions", () => {
    const { result } = publish(true);
    const subscriptions = new SubscriptionStore(database);
    const before = subscriptions.get(memberId);
    const oldToken = before.url.split("/").at(-1)!;
    const afterLink = subscriptions.resetToken(memberId);
    expect(afterLink.credentialGeneration).toBe(before.credentialGeneration);
    expect(afterLink.configJson).toBe(before.configJson);
    expect(() => subscriptions.byToken(oldToken)).toThrow("订阅不存在");
    const original = configuration.getConfig(machineId, create(GetConfigRequestSchema, { revisionId: result.revisionId }));
    const oldPassword = readProxyCredentials(memberId, database).secrets.trojanPassword;
    const afterCredentials = subscriptions.resetProxyCredentials(memberId);
    expect(afterCredentials.url).toBe(afterLink.url);
    expect(afterCredentials.credentialGeneration).toBe(before.credentialGeneration + 1);
    const oldRevision = configuration.getConfig(machineId, create(GetConfigRequestSchema, { revisionId: result.revisionId }));
    expect(oldRevision.configSha256).toBe(original.configSha256);
    expect(oldRevision.configJson).toEqual(original.configJson);
    const latest = JSON.parse(Buffer.from(oldRevision.latestAuthorizationJson).toString("utf8"));
    expect(oldRevision.latestPolicyRevision).toBeGreaterThan(oldRevision.policyRevision);
    expect(JSON.stringify(latest)).not.toContain(oldPassword);
    expect(JSON.stringify(latest)).toContain(readProxyCredentials(memberId, database).secrets.trojanPassword);
    expect(configuration.get(machineId).latestTask?.kind).toBe("apply_config");
  });
  it("rejects stale previews and reapplies authorization before the embedded core first starts", () => {
    const { result } = publish();
    const preview = configuration.preview(machineId, { expectedVersion: result.version, settings }, adminId);
    database.db.update(users).set({ status: "disabled", version: 2 }).where(eq(users.id, memberId)).run();
    expect(() => configuration.publish(machineId, { previewId: preview.previewId, expectedVersion: result.version, requestKey: newId() }, adminId)).toThrow("账号授权已变化");
    configuration.reconcile();
    const latest = configuration.get(machineId);
    expect(latest.latestTask?.kind).toBe("apply_config");
    const response = configuration.getConfig(machineId, create(GetConfigRequestSchema, { revisionId: latest.desiredRevisionId! }));
    const rendered = JSON.parse(Buffer.from(response.configJson).toString("utf8"));
    expect(rendered.inbounds[0].users.map((user: { name: string }) => user.name)).toEqual([adminId]);
    expect(Buffer.from(response.latestAuthorizationJson).toString("utf8")).not.toContain(memberId);
  });
  it("does not advance the policy for an irrelevant role change or an unlimited user's new month", () => {
    const policy = new PolicyStore(database);
    const first = policy.refresh(Date.UTC(2026, 8, 15));
    database.db.update(users).set({ role: "admin", version: 2 }).where(eq(users.id, memberId)).run();
    expect(policy.refresh(Date.UTC(2026, 8, 15)).policyRevision).toBe(first.policyRevision);
    expect(policy.refresh(Date.UTC(2026, 9, 15)).policyRevision).toBe(first.policyRevision);
  });
  it("shows the global authorization floor as pending before the coordinator publishes a replacement revision", () => {
    const { result, preview } = publish(true);
    expect(configuration.get(machineId).reconciliation).toBe("applied");
    const required = database.db.transaction((tx) => {
      tx.update(users).set({ monthlyLimitBytes: "0", version: 2 }).where(eq(users.id, memberId)).run();
      return new PolicyStore(database).refresh();
    });
    // The account transaction has committed, but the five-second coordinator has not run.
    expect(database.db.select().from(machineConfigs).where(eq(machineConfigs.machineId, machineId)).get()?.desiredPolicyRevision).toBe(Number(preview.policyRevision));
    const current = configuration.get(machineId);
    expect(current.reconciliation).toBe("pending");
    expect(current.desiredPolicyRevision).toBe(required.policyRevision);
    expect(current.appliedPolicyRevision).toBe(preview.policyRevision);
    expect(current.desiredRevisionId).toBe(result.revisionId);
    expect(current.version).toBe(result.version);
  });
  it("counts exact integers beyond Number.MAX_SAFE_INTEGER once and keeps high-water marks after pruning", () => {
    publish();
    const end = Date.now() - 1000;
    const request = report(1n, [{ userId: memberId, startUnixMs: BigInt(end - 5000), endUnixMs: BigInt(end), uploadBytes: 9007199254740993n, downloadBytes: 7n }]);
    expect(usage.reportUsage(machineStore.get(machineId), request)).toEqual({ committedSequence: 1n, expectedSequence: 2n });
    expect(usage.reportUsage(machineStore.get(machineId), request)).toEqual({ committedSequence: 1n, expectedSequence: 2n });
    const totals = usage.query({ userId: memberId, grain: "month" });
    expect(totals.uploadBytes).toBe("9007199254740993");
    expect(totals.downloadBytes).toBe("7");
    expect(totals.currentMonth?.usedBytes).toBe("9007199254741000");
    usage.cleanMinutes(Date.now() + 31 * 86_400_000);
    expect(usage.reportUsage(machineStore.get(machineId), request).committedSequence).toBe(1n);
    expect(usage.query({ userId: memberId, grain: "month" }).uploadBytes).toBe(totals.uploadBytes);
    database.sqlite.close(); database = openDatabase(join(directory, "panel.sqlite")); usage = new UsageStore(database); machineStore = new MachineStore(database);
    expect(usage.reportUsage(machineStore.get(machineId), request).committedSequence).toBe(1n);
  });
  it("rolls back a partially processed invalid batch, refuses changed retry content and requests missing sequences", () => {
    publish();
    const end = Date.now() - 1000;
    const delta = { userId: memberId, startUnixMs: BigInt(end - 5000), endUnixMs: BigInt(end), uploadBytes: 50n, downloadBytes: 50n };
    const good = report(1n, [delta]);
    usage.reportUsage(machineStore.get(machineId), good);
    expect(usage.reportUsage(machineStore.get(machineId), report(3n, [delta]))).toEqual({ committedSequence: 1n, expectedSequence: 2n });
    expect(() => usage.reportUsage(machineStore.get(machineId), report(1n, [{ ...delta, uploadBytes: 51n }]))).toThrow("USAGE_PAYLOAD_CONFLICT");
    const before = usage.query({ userId: memberId });
    expect(() => usage.reportUsage(machineStore.get(machineId), report(2n, [delta, { ...delta, userId: newId() }]))).toThrow("never been authorized");
    expect(usage.query({ userId: memberId })).toEqual(before);
    expect(database.db.select().from(usageStreams).get()?.committedSequence).toBe("1");
  });
  it("splits midnight/month boundaries exactly and only applies the current month's quota", () => {
    publish();
    const boundary = monthStart(Date.UTC(2026, 8, 15));
    const now = boundary + 60_000;
    database.db.update(users).set({ monthlyLimitBytes: "80", version: 2 }).where(eq(users.id, memberId)).run();
    usage.reportUsage(machineStore.get(machineId), report(1n, [{ userId: memberId, startUnixMs: BigInt(boundary - 1000), endUnixMs: BigInt(boundary + 1000), uploadBytes: 101n, downloadBytes: 1n }]), now);
    const current = usage.query({ userId: memberId, start: boundary, end: boundary + 86_400_000, grain: "day" }, now);
    expect(current.currentMonth?.usedBytes).toBe("50");
    expect(current.currentMonth?.blocked).toBe(false);
    const previousRows = database.db.select().from(usageBuckets).where(and(eq(usageBuckets.userId, memberId), eq(usageBuckets.grain, "month"))).all();
    expect(previousRows.reduce((sum, row) => sum + BigInt(row.uploadBytes) + BigInt(row.downloadBytes), 0n)).toBe(102n);
    usage.reportUsage(machineStore.get(machineId), report(2n, [{ userId: memberId, startUnixMs: BigInt(boundary - 5000), endUnixMs: BigInt(boundary - 2000), uploadBytes: 1000n, downloadBytes: 0n }]), now);
    expect(usage.query({ userId: memberId, grain: "month" }, now).currentMonth?.blocked).toBe(false);
    usage.reportUsage(machineStore.get(machineId), report(3n, [{ userId: memberId, startUnixMs: BigInt(boundary + 1000), endUnixMs: BigInt(boundary + 5000), uploadBytes: 30n, downloadBytes: 0n }]), now);
    expect(usage.query({ userId: memberId, grain: "month" }, now).currentMonth?.blocked).toBe(true);
    expect(new PolicyStore(database).refresh(now).users.some((user) => user.id === memberId)).toBe(false);
    expect(new PolicyStore(database).refresh(Date.UTC(2026, 9, 15)).users.some((user) => user.id === memberId)).toBe(true);
    database.db.update(users).set({ status: "disabled" }).where(eq(users.id, memberId)).run();
    expect(new PolicyStore(database).refresh(Date.UTC(2026, 10, 15)).users.some((user) => user.id === memberId)).toBe(false);
    expect(database.db.select().from(policyState).get()?.revision).toBeGreaterThan(1);
  });
  it("keeps minute, day and month attribution identical for a long sample crossing a month boundary", () => {
    publish();
    const boundary = monthStart(Date.now());
    usage.reportUsage(machineStore.get(machineId), report(1n, [{ userId: memberId, startUnixMs: BigInt(boundary - 90_000), endUnixMs: BigInt(boundary + 90_000), uploadBytes: 4n, downloadBytes: 0n }]), boundary + 180_000);
    const rows = database.db.select().from(usageBuckets).where(eq(usageBuckets.userId, memberId)).all();
    const minuteTotal = rows.filter((row) => row.grain === "minute" && row.bucketStart >= boundary).reduce((sum, row) => sum + BigInt(row.uploadBytes), 0n);
    expect(rows.find((row) => row.grain === "day" && row.bucketStart === boundary)?.uploadBytes).toBe(minuteTotal.toString());
    expect(rows.find((row) => row.grain === "month" && row.bucketStart === boundary)?.uploadBytes).toBe(minuteTotal.toString());
  });
  it("computes the largest minute average across selected users and machines without using day totals", () => {
    publish();
    const base = bucketStart(Date.now() - 2 * DAY_MS, "minute") - 180_000;
    const day = bucketStart(base, "day");
    const delta = (userId: string, minute: number, uploadBytes: bigint) => ({ userId, startUnixMs: BigInt(base + minute * 60_000 + 1000), endUnixMs: BigInt(base + minute * 60_000 + 6000), uploadBytes, downloadBytes: 0n });
    usage.reportUsage(machineStore.get(machineId), report(1n, [delta(memberId, 0, 600n), delta(adminId, 0, 5400n), delta(memberId, 1, 3000n)]));
    const second = machineStore.create({ name: "Second node", address: "node.test", region: "" });
    const secondMachine = machineStore.bind(second.id, create(InstallationSchema, { installationId: "test-installation-0002" }), { daemonVersion: "test", os: "linux", arch: "amd64", supportedTasks: [TaskKind.APPLY_CONFIG] });
    const preview = configuration.preview(second.id, { expectedVersion: 0, settings }, adminId);
    configuration.publish(second.id, { previewId: preview.previewId, expectedVersion: 0, requestKey: newId() }, adminId);
    const secondReport = report(1n, [delta(memberId, 0, 6000n)]);
    secondReport.installation = create(InstallationSchema, { installationId: "test-installation-0002", bindingEpoch: 1n });
    usage.reportUsage(secondMachine, secondReport);
    const range = { start: day, end: day + DAY_MS, grain: "day" };
    expect(usage.query(range).peakMinuteAverageBytesPerSecond).toBe(200);
    expect(usage.query({ ...range, userId: memberId }).peakMinuteAverageBytesPerSecond).toBe(110);
    expect(usage.query({ ...range, machineId }).peakMinuteAverageBytesPerSecond).toBe(100);
    expect(usage.query({ ...range, userId: memberId, machineId }).peakMinuteAverageBytesPerSecond).toBe(50);
    expect(usage.query(range).uploadBytes).toBe("15000");
  });
  it("returns no peak for expired minute detail or known gaps instead of inventing one from day totals", () => {
    publish();
    const now = Date.now();
    const old = bucketStart(now - 31 * DAY_MS, "day");
    usage.reportUsage(machineStore.get(machineId), report(1n, [{ userId: memberId, startUnixMs: BigInt(old + 1000), endUnixMs: BigInt(old + 6000), uploadBytes: 6000n, downloadBytes: 0n }]), now);
    const historical = usage.query({ userId: memberId, start: old, end: old + DAY_MS, grain: "day" }, now);
    expect(historical.uploadBytes).toBe("6000");
    expect(historical.peakMinuteAverageBytesPerSecond).toBeNull();
    const recent = bucketStart(now - DAY_MS, "day");
    usage.reportUsage(machineStore.get(machineId), report(2n, [{ userId: memberId, startUnixMs: BigInt(recent + 1000), endUnixMs: BigInt(recent + 6000), uploadBytes: 60n, downloadBytes: 0n, incomplete: true }]), now);
    expect(usage.query({ userId: memberId, start: recent, end: recent + DAY_MS, grain: "day" }, now).peakMinuteAverageBytesPerSecond).toBeNull();
  });
  it("compares natural calendar months with exact integers and suppresses a ratio while the current month is unfinished", () => {
    publish();
    const start = monthStart(Date.now());
    const end = nextBucket(start, "month");
    const previousStart = monthStart(start - 1);
    const delta = (at: number, uploadBytes: bigint, downloadBytes: bigint) => ({ userId: memberId, startUnixMs: BigInt(at + 1000), endUnixMs: BigInt(at + 6000), uploadBytes, downloadBytes });
    usage.reportUsage(machineStore.get(machineId), report(1n, [delta(previousStart, 9007199254740993n, 7n)]));
    usage.reportUsage(machineStore.get(machineId), report(2n, [delta(start, 18014398509481986n, 14n)]));
    const range = { userId: memberId, start, end, grain: "day" };
    const current = usage.query(range);
    expect(current.previousPeriod).toMatchObject({ previousStart, previousEnd: start, uploadBytes: "9007199254740993", downloadBytes: "7", hasData: true, currentPeriodInProgress: true, changePercent: null });
    const finished = usage.query(range, end + DAY_MS);
    expect(finished.previousPeriod.currentPeriodInProgress).toBe(false);
    expect(finished.previousPeriod.changePercent).toBe(100);
  });
  it("uses an equal prior duration for other ranges and distinguishes missing, zero, and incomplete previous data", () => {
    publish();
    const start = bucketStart(Date.now() - 2 * DAY_MS, "day");
    const range = { userId: memberId, start, end: start + DAY_MS, grain: "day" };
    const delta = (at: number, bytes: bigint, incomplete = false) => ({ userId: memberId, startUnixMs: BigInt(at + 1000), endUnixMs: BigInt(at + 6000), uploadBytes: bytes, downloadBytes: 0n, incomplete });
    usage.reportUsage(machineStore.get(machineId), report(1n, [delta(start, 150n)]));
    expect(usage.query(range).previousPeriod).toMatchObject({ previousStart: start - DAY_MS, previousEnd: start, hasData: false, changePercent: null });
    usage.reportUsage(machineStore.get(machineId), report(2n, [delta(start - DAY_MS, 0n)]));
    expect(usage.query(range).previousPeriod).toMatchObject({ hasData: true, uploadBytes: "0", changePercent: null });
    usage.reportUsage(machineStore.get(machineId), report(3n, [delta(start - DAY_MS, 100n)]));
    expect(usage.query(range).previousPeriod.changePercent).toBe(50);
    usage.reportUsage(machineStore.get(machineId), report(4n, [delta(start - DAY_MS, 0n, true)]));
    expect(usage.query(range).previousPeriod).toMatchObject({ hasData: true, incomplete: true, changePercent: null });
  });
  it("marks zero-byte gaps incomplete and rejects managed overrides or mismatched certificates", () => {
    publish();
    const end = Date.now() - 1000;
    usage.reportUsage(machineStore.get(machineId), report(1n, [{ userId: memberId, startUnixMs: BigInt(end - 5000), endUnixMs: BigInt(end), uploadBytes: 0n, downloadBytes: 0n, incomplete: true }]));
    expect(usage.query({ userId: memberId }).incomplete).toBe(true);
    expect(() => validateSettings({ ...settings, baseJson: { inbounds: [] } })).toThrow("平台管理");
    expect(() => validateSettings({ ...settings, tls: { ...settings.tls, serverName: "not-in-certificate.example" } })).toThrow("证书与服务器名称不匹配");
    const rendered = renderServer(validateSettings(settings), { version: 1, policyRevision: "2", users: [] });
    expect(rendered.services).toBeUndefined();
    expect(jsonBytes(rendered).toString()).not.toContain("v2ray_api");
  });
  it("overlays live metering and transport problems only on the current window and clears them after recovery", () => {
    publish(true);
    const now = Date.now();
    const today = bucketStart(now, "day");
    const currentRange = { userId: memberId, start: today, end: today + 2 * DAY_MS, grain: "day" };
    const historicalRange = { userId: memberId, start: today - DAY_MS, end: today, grain: "day" };
    usage.reportUsage(machineStore.get(machineId), report(1n, [
      { userId: memberId, startUnixMs: BigInt(now - 5000), endUnixMs: BigInt(now - 1000), uploadBytes: 100n, downloadBytes: 0n },
      { userId: memberId, startUnixMs: BigInt(today - DAY_MS + 1000), endUnixMs: BigInt(today - DAY_MS + 5000), uploadBytes: 50n, downloadBytes: 0n },
    ]));
    expect(usage.query(currentRange).incomplete).toBe(false);
    const machine = machineStore.get(machineId);
    const healthy = fromJsonString(MachineStatusSchema, machine.statusJson!);
    machineStore.reportStatus(machine, BigInt(machine.sessionEpoch), 2n, { ...healthy, usageIncomplete: true, issue: "Usage reporting is waiting for recovery" });
    expect(usage.query(currentRange).incomplete).toBe(true);
    expect(usage.query(currentRange).groups[0].incomplete).toBe(true);
    expect(usage.query(currentRange).peakMinuteAverageBytesPerSecond).toBeNull();
    expect(usage.query(historicalRange).incomplete).toBe(false);
    expect(database.db.select().from(usageBuckets).all().some((row) => row.incomplete)).toBe(false);
    usage.reportUsage(machineStore.get(machineId), report(2n, [{ userId: memberId, startUnixMs: BigInt(now - 1000), endUnixMs: BigInt(now), uploadBytes: 20n, downloadBytes: 0n }]));
    machineStore.reportStatus(machineStore.get(machineId), BigInt(machine.sessionEpoch), 3n, { ...healthy, usageIncomplete: false, issue: "" });
    const recovered = usage.query(currentRange);
    expect(recovered.incomplete).toBe(false);
    expect(recovered.uploadBytes).toBe("120");
    expect(usage.query(currentRange, Date.now() + 61_000).incomplete).toBe(true);
    expect(usage.query(historicalRange, Date.now() + 61_000).incomplete).toBe(false);
    machineStore.reportStatus(machineStore.get(machineId), BigInt(machine.sessionEpoch), 4n, { ...healthy, observedAtUnixMs: BigInt(Date.now()), usageIncomplete: false });
    expect(usage.query(currentRange).incomplete).toBe(false);
  });
  it("scopes current reporting health to associated users/nodes and excludes removed or drained uninstalled nodes", () => {
    publish(true);
    const now = Date.now();
    const today = bucketStart(now, "day");
    const range = { start: today, end: today + 2 * DAY_MS, grain: "day" };
    usage.reportUsage(machineStore.get(machineId), report(1n, [{ userId: memberId, startUnixMs: BigInt(now - 5000), endUnixMs: BigInt(now - 1000), uploadBytes: 100n, downloadBytes: 0n }]));
    const other = machineStore.create({ name: "Admin-only history", address: "other.test", region: "" });
    const bound = machineStore.bind(other.id, create(InstallationSchema, { installationId: "other-installation-0003" }), { daemonVersion: "test", os: "linux", arch: "amd64", supportedTasks: [TaskKind.INSPECT] });
    // Historical association represents a node on which only this account was authorized.
    database.db.insert(machineUserHistory).values({ machineId: other.id, userId: adminId }).run();
    machineStore.reportStatus(bound, BigInt(bound.sessionEpoch), 1n, create(MachineStatusSchema, { observedAtUnixMs: BigInt(now), coreHealth: CoreHealth.HEALTHY, usageIncomplete: true }));
    expect(usage.query({ ...range, userId: memberId }).incomplete).toBe(false);
    expect(usage.query({ ...range, machineId }).incomplete).toBe(false);
    expect(usage.query(range).incomplete).toBe(true);
    machineStore.remove(other.id);
    expect(usage.query(range).incomplete).toBe(false);
    const current = machineStore.get(machineId);
    const healthy = fromJsonString(MachineStatusSchema, current.statusJson!);
    machineStore.reportStatus(current, BigInt(current.sessionEpoch), 2n, { ...healthy, usageIncomplete: true });
    const task = new ReleaseStore(database).uninstall(machineId, { requestKey: newId() }).task;
    const row = database.db.select().from(tasks).where(eq(tasks.id, task.id)).get()!;
    machineStore.accept(machineStore.get(machineId), BigInt(current.sessionEpoch), task.id, row.payloadHash);
    machineStore.reportTask(current, create(ReportTaskRequestSchema, { installation: { installationId: current.installationId!, bindingEpoch: BigInt(current.bindingEpoch) }, taskId: task.id, payloadSha256: row.payloadHash, sequence: 1n, state: TaskState.SUCCEEDED, phase: "uninstalled" }));
    expect(usage.query(range).incomplete).toBe(false);
    expect(usage.query(range).uploadBytes).toBe("100");
  });
  it("cleans minute history in bounded batches while retaining day/month totals and stream receipts", () => {
    publish();
    const now = Date.now();
    // A real one-day report creates over 1000 minute projections.
    const request = report(1n, [{ userId: memberId, startUnixMs: BigInt(now - 86_400_000), endUnixMs: BigInt(now), uploadBytes: 1441n, downloadBytes: 0n }]);
    usage.reportUsage(machineStore.get(machineId), request, now);
    const before = database.db.select().from(usageBuckets).where(eq(usageBuckets.grain, "minute")).all().length;
    expect(before).toBeGreaterThan(1000);
    expect(usage.cleanMinutes(now + 32 * 86_400_000)).toBe(1000);
    expect(database.db.select().from(usageBuckets).where(eq(usageBuckets.grain, "minute")).all()).toHaveLength(before - 1000);
    expect(database.db.select().from(usageBuckets).where(eq(usageBuckets.grain, "month")).all().length).toBeGreaterThan(0);
    expect(database.db.select().from(usageStreams).get()?.committedSequence).toBe("1");
    expect(usage.reportUsage(machineStore.get(machineId), request, now).committedSequence).toBe(1n);
  });
});
