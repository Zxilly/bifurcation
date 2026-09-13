export const MAX_BYTES = 9223372036854775807n;
export const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;
export function monthStart(time: number): number {
  const date = new Date(time + SHANGHAI_OFFSET);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) - SHANGHAI_OFFSET;
}
export function monthPeriod(time: number): string {
  const date = new Date(time + SHANGHAI_OFFSET);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function bucketStart(time: number, grain: "minute" | "day" | "month") {
  if (grain === "month") return monthStart(time);
  const size = grain === "minute" ? 60_000 : DAY_MS;
  return Math.floor((time + SHANGHAI_OFFSET) / size) * size - SHANGHAI_OFFSET;
}
export function nextBucket(start: number, grain: "minute" | "day" | "month") {
  if (grain !== "month") return start + (grain === "minute" ? 60_000 : DAY_MS);
  const date = new Date(start + SHANGHAI_OFFSET);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - SHANGHAI_OFFSET;
}
export function splitBytes(start: number, end: number, bytes: bigint, grain: "minute" | "day" | "month") {
  const buckets: { start: number; bytes: bigint }[] = [];
  let allocated = 0n;
  for (let current = bucketStart(start, grain); current < end; current = nextBucket(current, grain)) {
    const overlap = Math.min(end, nextBucket(current, grain)) - Math.max(start, current);
    const part = bytes * BigInt(overlap) / BigInt(end - start);
    buckets.push({ start: current, bytes: part }); allocated += part;
  }
  // Deterministic integer remainder distribution, preserving the exact source total.
  let remainder = bytes - allocated;
  for (const bucket of buckets) { if (remainder === 0n) break; bucket.bytes++; remainder--; }
  return buckets;
}
