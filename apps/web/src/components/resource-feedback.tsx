"use client";

import { Banner, Button } from "@cloudflare/kumo";

const updatedTime = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

export function ResourceFeedback({
  error,
  updatedAt,
  refreshing,
  onRetry,
}: {
  error: string;
  updatedAt: number | null;
  refreshing: boolean;
  onRetry: () => Promise<void>;
}) {
  if (!error) return null;
  return (
    <Banner role="alert" variant={updatedAt ? "alert" : "error"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="font-medium">
            {updatedAt
              ? `刷新失败 · 显示 ${updatedTime.format(updatedAt)}（上海时间）的最近数据`
              : "数据暂时无法加载"}
          </p>
          <p className="break-words">{error}</p>
          {updatedAt && <p>最近数据不代表当前状态，请重新加载。</p>}
        </div>
        <Button onClick={onRetry} loading={refreshing}>
          重新加载
        </Button>
      </div>
    </Banner>
  );
}
