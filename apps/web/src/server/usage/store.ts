import "server-only";
import { and, asc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { fromBinary, fromJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { MachineStatusSchema, UsageBatchSchema, type ReportUsageRequest, type ReportUsageResponse } from "@bifurcation/rpc";
import { z } from "zod";
import type { UsageDto, UsageGroupDto, UsagePointDto } from "@/contracts/usage";
import { getDatabase, type DatabaseHandle } from "@/server/db";
import { machines } from "@/server/db/schema-machines";
import { users } from "@/server/db/schema";
import { machineUserHistory, usageBuckets, usageStreams } from "@/server/db/schema-proxy";
import { MachineStore } from "@/server/modules/machines/store";
import { PolicyStore, userQuota } from "@/server/configuration/policy";
import { sha256 } from "@/server/crypto";
import { AppError } from "@/server/http/errors";
import { bucketStart, DAY_MS, MAX_BYTES, monthStart, nextBucket, splitBytes } from "./time";

type MachineRow = typeof machines.$inferSelect;
const queryInput = z.object({ start: z.coerce.number().int().nonnegative().optional(), end: z.coerce.number().int().positive().optional(), grain: z.enum(["minute", "day", "month"]).default("day"), userId: z.string().uuid().optional(), machineId: z.string().uuid().optional() });
const invalid = (message: string) => new ConnectError(message, Code.InvalidArgument);
function rollupMinutes(minutes: { start: number; bytes: bigint }[], grain: "minute" | "day" | "month") {
  if (grain === "minute") return minutes;
  const buckets = new Map<number, bigint>();
  for (const minute of minutes) {
    const start = bucketStart(minute.start, grain);
    buckets.set(start, (buckets.get(start) ?? 0n) + minute.bytes);
  }
  return [...buckets].map(([start, bytes]) => ({ start, bytes }));
}

export class UsageStore {
  constructor(private readonly handle: DatabaseHandle = getDatabase()) {}

  private currentReportingIssues(start: number, end: number, now: number, userId?: string, machineId?: string): Set<string> {
    const issues = new Set<string>();
    // Live transport/metering health is an overlay for the current window only.
    // It never rewrites completed historical buckets or their completeness.
    if (start > now || end <= now) return issues;
    const filters = [isNull(machines.removedAt), isNotNull(machines.installationId)];
    if (userId) filters.push(eq(machineUserHistory.userId, userId));
    if (machineId) filters.push(eq(machines.id, machineId));
    const related = this.handle.db.selectDistinct({ id: machines.id, bindingEpoch: machines.bindingEpoch, statusJson: machines.statusJson, statusSequence: machines.statusSequence, lastSeenAt: machines.lastSeenAt })
      .from(machineUserHistory).innerJoin(machines, eq(machineUserHistory.machineId, machines.id)).where(and(...filters)).all();
    const machineStore = new MachineStore(this.handle);
    for (const machine of related) {
      if (machineStore.isUninstalled(machine.id, machine.bindingEpoch)) continue;
      const status = machine.statusJson ? fromJsonString(MachineStatusSchema, machine.statusJson) : undefined;
      if (!status || machine.statusSequence === 0 || status.usageIncomplete || machine.lastSeenAt === null || machine.lastSeenAt <= now - 60_000) issues.add(machine.id);
    }
    return issues;
  }

  private filters(grain: "minute" | "day" | "month", start: number, end: number, userId?: string, machineId?: string) {
    const filters = [eq(usageBuckets.grain, grain), gte(usageBuckets.bucketStart, start), lt(usageBuckets.bucketStart, end)];
    if (userId) filters.push(eq(usageBuckets.userId, userId));
    if (machineId) filters.push(eq(usageBuckets.machineId, machineId));
    return filters;
  }

  private sumPeriod(grain: "minute" | "day" | "month", start: number, end: number, userId?: string, machineId?: string) {
    const query = this.handle.db.select({
      uploadBytes: sql<string>`${usageBuckets.uploadBytes}`.as("uploadBytes"),
      downloadBytes: sql<string>`${usageBuckets.downloadBytes}`.as("downloadBytes"),
      incomplete: sql<number>`${usageBuckets.incomplete}`.as("incomplete"),
    }).from(usageBuckets).where(and(...this.filters(grain, start, end, userId, machineId))).toSQL();
    let upload = 0n, download = 0n, hasData = false, incomplete = false;
    // Stream exact decimal integers through BigInt instead of loading a second
    // period's full ledger into memory or overflowing SQLite's integer SUM.
    for (const value of this.handle.sqlite.prepare(query.sql).iterate(...query.params)) {
      const row = value as { uploadBytes: string; downloadBytes: string; incomplete: number };
      hasData = true; upload += BigInt(row.uploadBytes); download += BigInt(row.downloadBytes); incomplete ||= !!row.incomplete;
    }
    return { upload, download, hasData, incomplete };
  }

  private minutePeak(start: number, end: number, now: number, userId?: string, machineId?: string): number | null {
    if (start < now - 30 * DAY_MS) return null;
    const minuteTotals = this.handle.db.select({
      totalBytes: sql<number>`sum(cast(${usageBuckets.uploadBytes} as real) + cast(${usageBuckets.downloadBytes} as real))`.as("totalBytes"),
      incomplete: sql<number>`max(${usageBuckets.incomplete})`.as("incomplete"),
    }).from(usageBuckets).where(and(...this.filters("minute", start, end, userId, machineId))).groupBy(usageBuckets.bucketStart).as("minute_totals");
    const peak = this.handle.db.select({ value: sql<number | null>`max(${minuteTotals.totalBytes}) / 60.0`, incomplete: sql<number | null>`max(${minuteTotals.incomplete})` }).from(minuteTotals).get();
    // REAL is used only for this display rate; accounting and comparison totals
    // always retain exact integer bytes.
    return peak?.incomplete ? null : peak?.value ?? null;
  }

  reportUsage(machine: MachineRow, request: ReportUsageRequest, now = Date.now()): Pick<ReportUsageResponse, "committedSequence" | "expectedSequence"> {
    new MachineStore(this.handle).assertInstallation(machine, request.installation);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(request.streamId)) throw invalid("invalid usage stream ID");
    if (request.sequence <= 0n || request.sequence > MAX_BYTES) throw invalid("usage sequence out of range");
    if (request.payload.length > 1024 * 1024) throw new ConnectError("usage payload too large", Code.ResourceExhausted);
    if (!/^[a-f0-9]{64}$/.test(request.payloadSha256) || sha256(request.payload) !== request.payloadSha256) throw invalid("usage payload hash mismatch");
    return this.handle.db.transaction((tx) => {
      const streamWhere = and(eq(usageStreams.machineId, machine.id), eq(usageStreams.installationId, request.installation!.installationId), eq(usageStreams.streamId, request.streamId));
      const stream = tx.select().from(usageStreams).where(streamWhere).get();
      const committed = BigInt(stream?.committedSequence ?? "0");
      if (request.sequence <= committed) {
        if (request.sequence === committed && stream!.lastPayloadHash !== request.payloadSha256) throw new ConnectError("USAGE_PAYLOAD_CONFLICT", Code.AlreadyExists);
        return { committedSequence: committed, expectedSequence: committed + 1n };
      }
      if (request.sequence !== committed + 1n) return { committedSequence: committed, expectedSequence: committed + 1n };
      let batch;
      try { batch = fromBinary(UsageBatchSchema, request.payload); }
      catch { throw invalid("invalid usage protobuf"); }
      if (!batch.coreRuntimeId || batch.coreRuntimeId.length > 256 || batch.deltas.length === 0 || batch.deltas.length > 256) throw invalid("invalid usage batch metadata");
      const knownUsers = new Set(tx.select({ userId: machineUserHistory.userId }).from(machineUserHistory).where(eq(machineUserHistory.machineId, machine.id)).all().map((row) => row.userId));
      let projectionCount = 0;
      for (const delta of batch.deltas) {
        if (!knownUsers.has(delta.userId)) throw invalid("usage user has never been authorized on this machine");
        if (delta.startUnixMs < 0n || delta.endUnixMs > BigInt(Number.MAX_SAFE_INTEGER) || delta.endUnixMs <= delta.startUnixMs) throw invalid("invalid usage interval");
        const start = Number(delta.startUnixMs);
        const end = Number(delta.endUnixMs);
        if (end > now + 5 * 60_000 || end - start > DAY_MS) throw invalid("usage interval is outside accepted bounds");
        if (delta.uploadBytes < 0n || delta.downloadBytes < 0n || delta.uploadBytes + delta.downloadBytes > MAX_BYTES) throw invalid("usage bytes out of range");
        // One canonical attribution prevents independent remainder rounding from
        // disagreeing between minute, day and month views of the same sample.
        const minuteUpload = splitBytes(start, end, delta.uploadBytes, "minute");
        const minuteDownload = splitBytes(start, end, delta.downloadBytes, "minute");
        for (const grain of ["minute", "day", "month"] as const) {
          const upload = rollupMinutes(minuteUpload, grain);
          const download = rollupMinutes(minuteDownload, grain);
          projectionCount += grain === "minute" ? upload.filter((bucket) => bucket.start >= now - 30 * DAY_MS).length : upload.length;
          if (projectionCount > 20000) throw new ConnectError("usage batch spans too many time buckets", Code.ResourceExhausted);
          for (let index = 0; index < upload.length; index++) {
            const bucket = upload[index];
            if (grain === "minute" && bucket.start < now - 30 * DAY_MS) continue;
            const where = and(eq(usageBuckets.grain, grain), eq(usageBuckets.bucketStart, bucket.start), eq(usageBuckets.userId, delta.userId), eq(usageBuckets.machineId, machine.id));
            const previous = tx.select().from(usageBuckets).where(where).get();
            const uploadBytes = BigInt(previous?.uploadBytes ?? "0") + bucket.bytes;
            const downloadBytes = BigInt(previous?.downloadBytes ?? "0") + download[index].bytes;
            if (uploadBytes + downloadBytes > MAX_BYTES) throw new ConnectError("usage bucket overflow", Code.OutOfRange);
            const values = { uploadBytes: uploadBytes.toString(), downloadBytes: downloadBytes.toString(), estimated: (previous?.estimated ?? false) || delta.estimated || upload.length > 1, incomplete: (previous?.incomplete ?? false) || delta.incomplete };
            tx.insert(usageBuckets).values({ grain, bucketStart: bucket.start, userId: delta.userId, machineId: machine.id, ...values })
              .onConflictDoUpdate({ target: [usageBuckets.grain, usageBuckets.bucketStart, usageBuckets.userId, usageBuckets.machineId], set: values }).run();
          }
        }
      }
      // Quota cache and the durable authorization revision are committed with accounting.
      new PolicyStore(this.handle).refresh(now);
      tx.insert(usageStreams).values({ machineId: machine.id, installationId: request.installation!.installationId, streamId: request.streamId, committedSequence: request.sequence.toString(), lastPayloadHash: request.payloadSha256, lastSeenAt: now })
        .onConflictDoUpdate({ target: [usageStreams.machineId, usageStreams.installationId, usageStreams.streamId], set: { committedSequence: request.sequence.toString(), lastPayloadHash: request.payloadSha256, lastSeenAt: now } }).run();
      return { committedSequence: request.sequence, expectedSequence: request.sequence + 1n };
    });
  }

  query(input: unknown, now = Date.now()): UsageDto {
    const parsed = queryInput.parse(input);
    const grain = parsed.grain;
    const start = bucketStart(parsed.start ?? monthStart(now), grain);
    const suppliedEnd = parsed.end ?? nextBucket(monthStart(now), "month");
    const end = bucketStart(suppliedEnd, grain) === suppliedEnd ? suppliedEnd : nextBucket(bucketStart(suppliedEnd, grain), grain);
    if (end <= start || end > now + 32 * DAY_MS || end - start > (grain === "minute" ? 7 : grain === "day" ? 366 : 3660) * DAY_MS) throw new AppError("INVALID_TIME_RANGE", "查询时间范围超出限制", 422);
    const filters = this.filters(grain, start, end, parsed.userId, parsed.machineId);
    const rows = this.handle.db.select({ bucket: usageBuckets, username: users.username, machineName: machines.name }).from(usageBuckets)
      .innerJoin(users, eq(usageBuckets.userId, users.id)).innerJoin(machines, eq(usageBuckets.machineId, machines.id)).where(and(...filters)).orderBy(asc(usageBuckets.bucketStart)).all();
    const reportingIssues = this.currentReportingIssues(start, end, now, parsed.userId, parsed.machineId);
    const points = new Map<number, UsagePointDto>();
    const groups = new Map<string, UsageGroupDto>();
    let upload = 0n, download = 0n;
    for (const { bucket, username, machineName } of rows) {
      const up = BigInt(bucket.uploadBytes), down = BigInt(bucket.downloadBytes);
      upload += up; download += down;
      const point = points.get(bucket.bucketStart) ?? { bucketStart: bucket.bucketStart, uploadBytes: "0", downloadBytes: "0", estimated: false, incomplete: false };
      point.uploadBytes = (BigInt(point.uploadBytes) + up).toString(); point.downloadBytes = (BigInt(point.downloadBytes) + down).toString();
      point.estimated ||= bucket.estimated; point.incomplete ||= bucket.incomplete; points.set(bucket.bucketStart, point);
      const groupKey = `${bucket.userId}:${bucket.machineId}`;
      const group = groups.get(groupKey) ?? { userId: bucket.userId, username, machineId: bucket.machineId, machineName, uploadBytes: "0", downloadBytes: "0", estimated: false, incomplete: false };
      group.uploadBytes = (BigInt(group.uploadBytes) + up).toString(); group.downloadBytes = (BigInt(group.downloadBytes) + down).toString();
      group.estimated ||= bucket.estimated; group.incomplete ||= bucket.incomplete || reportingIssues.has(bucket.machineId); groups.set(groupKey, group);
    }
    const quota = parsed.userId ? userQuota(parsed.userId, this.handle, now) : null;
    const currentMonth = quota ? {
      period: quota.period, usedBytes: quota.used.toString(), limitBytes: quota.limit?.toString() ?? null, blocked: quota.blocked,
      warning: quota.limit === null ? null : quota.used >= quota.limit ? "100" as const : quota.used * 100n >= quota.limit * 95n ? "95" as const : quota.used * 100n >= quota.limit * 80n ? "80" as const : null,
    } : null;
    if (reportingIssues.size) {
      const currentPoint = points.get(bucketStart(now, grain));
      if (currentPoint) currentPoint.incomplete = true;
    }
    const incomplete = reportingIssues.size > 0 || rows.length === 0 || rows.some(({ bucket }) => bucket.incomplete) || (grain === "minute" && start < now - 30 * DAY_MS);
    const naturalMonth = start === monthStart(start) && end === nextBucket(start, "month");
    const previousStart = naturalMonth ? monthStart(start - 1) : start - (end - start);
    const previousEnd = start;
    const previousGrain = naturalMonth ? "month" : grain === "month" ? "day" : grain;
    const previous = this.sumPeriod(previousGrain, previousStart, previousEnd, parsed.userId, parsed.machineId);
    const previousIncomplete = !previous.hasData || previous.incomplete || (previousGrain === "minute" && previousStart < now - 30 * DAY_MS);
    const currentPeriodInProgress = end > now;
    const previousTotal = previous.upload + previous.download;
    let changePercent: number | null = null;
    if (!currentPeriodInProgress && !incomplete && !previousIncomplete && previous.hasData && previousTotal > 0n) {
      const numerator = (upload + download - previousTotal) * 10000n;
      const basisPoints = numerator >= 0n ? (numerator + previousTotal / 2n) / previousTotal : -((-numerator + previousTotal / 2n) / previousTotal);
      changePercent = Number(basisPoints) / 100;
    }
    return {
      start, end, grain, uploadBytes: upload.toString(), downloadBytes: download.toString(), estimated: rows.some(({ bucket }) => bucket.estimated), incomplete,
      points: [...points.values()], groups: [...groups.values()], currentMonth,
      peakMinuteAverageBytesPerSecond: reportingIssues.size ? null : this.minutePeak(start, end, now, parsed.userId, parsed.machineId),
      previousPeriod: { previousStart, previousEnd, uploadBytes: previous.upload.toString(), downloadBytes: previous.download.toString(), hasData: previous.hasData, incomplete: previousIncomplete, currentPeriodInProgress, changePercent },
    };
  }

  cleanMinutes(now = Date.now()) {
    return this.handle.db.run(sql`DELETE FROM ${usageBuckets} WHERE rowid IN (
      SELECT rowid FROM ${usageBuckets} WHERE ${usageBuckets.grain} = 'minute'
      AND ${usageBuckets.bucketStart} < ${now - 30 * DAY_MS} ORDER BY ${usageBuckets.bucketStart} LIMIT 1000
    )`).changes;
  }
}
