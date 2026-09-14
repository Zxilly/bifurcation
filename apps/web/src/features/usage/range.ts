import { Grain } from "@bifurcation/rpc/panel/usage";

// Period arithmetic shared by the Server Components that prefetch usage and
// the Client Components that poll it, so both sides derive the same SWR key.
export type UsagePeriod = "today" | "7days" | "30days" | "month";
export type UsageRange = { start: number; end: number; grain: "minute" | "day" };

const dayMilliseconds = 86_400_000;
const offset = 8 * 3_600_000;

export function currentShanghaiMonth(now: number) {
  return new Date(now + offset).toISOString().slice(0, 7);
}

export function periodRange(period: UsagePeriod, month: string, now: number): UsageRange {
  const dayStart =
    Math.floor((now + offset) / dayMilliseconds) * dayMilliseconds - offset;
  if (period !== "month")
    return {
      start:
        dayStart -
        (period === "7days" ? 6 : period === "30days" ? 29 : 0) *
          dayMilliseconds,
      end: dayStart + dayMilliseconds,
      grain: period === "today" ? "minute" : "day",
    };
  const [year, monthNumber] = month.split("-").map(Number);
  return {
    start: Date.UTC(year, monthNumber - 1, 1) - offset,
    end: Date.UTC(year, monthNumber, 1) - offset,
    grain: "day",
  };
}

export function usageRequest(range: UsageRange) {
  return {
    start: BigInt(range.start),
    end: BigInt(range.end),
    grain: range.grain === "minute" ? Grain.MINUTE : Grain.DAY,
  };
}

export function usageKey(range: UsageRange, suffix = "") {
  return `usage:${range.start}:${range.end}:${range.grain}:${suffix}`;
}

// The ranges `useUsagePeriod` starts with, computed server-side so the page
// can provide fallback data under the key the client will read first.
export function initialUsageRanges(now = Date.now()) {
  const month = currentShanghaiMonth(now);
  return { month: periodRange("month", month, now), today: periodRange("today", month, now) };
}
