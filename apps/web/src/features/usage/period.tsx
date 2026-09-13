"use client";

import { useEffect, useState } from "react";
import { Input } from "@cloudflare/kumo/components/input";

type UsagePeriod = "today" | "7days" | "30days" | "month";
const dayMilliseconds = 86_400_000;
const offset = 8 * 3_600_000;

function currentShanghaiMonth(now: number) {
  return new Date(now + offset).toISOString().slice(0, 7);
}

export function periodRange(period: UsagePeriod, month: string, now: number) {
  const dayStart =
    Math.floor((now + offset) / dayMilliseconds) * dayMilliseconds - offset;
  if (period !== "month")
    return {
      start:
        dayStart -
        (period === "7days" ? 6 : period === "30days" ? 29 : 0) *
          dayMilliseconds,
      end: dayStart + dayMilliseconds,
      grain: period === "today" ? ("minute" as const) : ("day" as const),
    };
  const [year, monthNumber] = month.split("-").map(Number);
  return {
    start: Date.UTC(year, monthNumber - 1, 1) - offset,
    end: Date.UTC(year, monthNumber, 1) - offset,
    grain: "day" as const,
  };
}

export function useUsagePeriod() {
  const [now, setNow] = useState(() => Date.now());
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [month, setMonth] = useState(() => currentShanghaiMonth(now));
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);
  const range = periodRange(period, month, now);
  const query = new URLSearchParams({
    start: String(range.start),
    end: String(range.end),
    grain: range.grain,
  }).toString();
  return { now, period, setPeriod, month, setMonth, range, query };
}

export function PeriodPicker({
  value,
}: {
  value: ReturnType<typeof useUsagePeriod>;
}) {
  return (
    <div className="actions">
      <label className="sr-only" htmlFor="usage-period">
        时间范围
      </label>
      <select
        id="usage-period"
        className="field-select"
        value={value.period}
        onChange={(event) => value.setPeriod(event.target.value as UsagePeriod)}
      >
        <option value="today">今天</option>
        <option value="7days">最近 7 天</option>
        <option value="30days">最近 30 天</option>
        <option value="month">指定月份</option>
      </select>
      {value.period === "month" && (
        <Input
          aria-label="统计月份"
          type="month"
          value={value.month}
          max={currentShanghaiMonth(value.now)}
          min="2020-01"
          onChange={(event) => {
            if (/^\d{4}-\d{2}$/.test(event.target.value))
              value.setMonth(event.target.value);
          }}
        />
      )}
    </div>
  );
}
