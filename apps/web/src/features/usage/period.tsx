"use client";

import { Select } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { Input } from "@cloudflare/kumo/components/input";
import { currentShanghaiMonth, periodRange, type UsagePeriod } from "./range";

export function useUsagePeriod() {
  const [now, setNow] = useState(() => Date.now());
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [month, setMonth] = useState(() => currentShanghaiMonth(now));
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);
  const range = periodRange(period, month, now);
  return { now, period, setPeriod, month, setMonth, range };
}

export function PeriodPicker({
  value,
}: {
  value: ReturnType<typeof useUsagePeriod>;
}) {
  return (
    <div className="actions">
      <Select
        aria-label="时间范围"
        items={{
          today: "今天",
          "7days": "最近 7 天",
          "30days": "最近 30 天",
          month: "指定月份",
        }}
        value={value.period}
        onValueChange={(period) => value.setPeriod(period as UsagePeriod)}
      />
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
