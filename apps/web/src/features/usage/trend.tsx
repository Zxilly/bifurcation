"use client";

import dynamic from "next/dynamic";
import type { UsageChartPoint } from "./usage-chart";
import { formatGiB } from "./format";

const UsageChart = dynamic(() => import("./usage-chart"), {
  ssr: false,
  loading: () => (
    <div
      role="status"
      className="flex h-[260px] items-center justify-center subtle"
    >
      正在加载图表…
    </div>
  ),
});

export function Trend({
  points,
  kind = "bar",
}: {
  points: UsageChartPoint[];
  kind?: "bar" | "line";
}) {
  if (!points.length) return <p className="empty-state">暂无用量数据</p>;
  return (
    <>
      <UsageChart points={points} kind={kind} />
      <details className="mt-5">
        <summary className="cursor-pointer subtle text-xs py-2">
          查看数值
        </summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>上传</th>
                <th>下载</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point, index) => (
                <tr key={`${point.label}-${index}`}>
                  <td>{point.label}</td>
                  <td>
                    {point.uploadBytes === null
                      ? "无数据"
                      : formatGiB(point.uploadBytes)}
                  </td>
                  <td>
                    {point.downloadBytes === null
                      ? "无数据"
                      : formatGiB(point.downloadBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
