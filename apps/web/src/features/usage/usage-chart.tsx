"use client";

import { useMemo } from "react";
import {
  Chart,
  ChartPalette,
  type KumoChartOption,
} from "@cloudflare/kumo/components/chart";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { gib } from "./format";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  AriaComponent,
  CanvasRenderer,
]);

export type UsageChartPoint = {
  label: string;
  uploadBytes: bigint | null;
  downloadBytes: bigint | null;
};

export default function UsageChart({
  points,
  kind = "bar",
}: {
  points: UsageChartPoint[];
  kind?: "bar" | "line";
}) {
  const options = useMemo<KumoChartOption>(() => {
    const palette = ChartPalette.sequential("blues");
    return {
      animation: false,
      aria: {
        enabled: true,
        label: { description: "上传和下载用量，单位 GiB。" },
      },
      color: [ChartPalette.categorical(0), palette[1]],
      textStyle: {
        fontFamily: "Inter, Noto Sans SC, sans-serif",
        color: ChartPalette.text("primary"),
      },
      tooltip: {
        trigger: "axis",
        renderMode: "richText",
        confine: true,
        valueFormatter: (value) =>
          typeof value === "number"
            ? value > 0 && value < 0.001
              ? "<0.001 GiB"
              : `${value.toLocaleString("zh-CN", { maximumFractionDigits: 3 })} GiB`
            : "无数据",
      },
      legend: {
        data: ["下载", "上传"],
        right: 0,
        top: 0,
        icon: "rect",
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: ChartPalette.text("primary"), fontSize: 12 },
      },
      grid: { left: 6, right: 12, top: 48, bottom: 4, containLabel: true },
      xAxis: {
        type: "category",
        data: points.map((point) => point.label),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: ChartPalette.text("primary"),
          hideOverlap: true,
          margin: 16,
        },
      },
      yAxis: {
        type: "value",
        name: "GiB",
        nameTextStyle: { color: ChartPalette.text("primary"), align: "left" },
        splitNumber: 3,
        axisLabel: { color: ChartPalette.text("primary") },
        splitLine: { lineStyle: { color: ChartPalette.semantic("Skeleton") } },
      },
      series: [
        {
          name: "下载",
          type: kind,
          stack: kind === "bar" ? "usage" : undefined,
          data: points.map((point) =>
            point.downloadBytes === null ? null : gib(point.downloadBytes),
          ),
          barMaxWidth: 54,
          showSymbol: kind === "line" && points.length === 1,
          symbolSize: 6,
          connectNulls: false,
        },
        {
          name: "上传",
          type: kind,
          stack: kind === "bar" ? "usage" : undefined,
          data: points.map((point) =>
            point.uploadBytes === null ? null : gib(point.uploadBytes),
          ),
          barMaxWidth: 54,
          showSymbol: kind === "line" && points.length === 1,
          symbolSize: 6,
          connectNulls: false,
        },
      ],
    };
  }, [points, kind]);
  return (
    <Chart
      echarts={echarts}
      options={options}
      height={260}
      optionUpdateBehavior={{ notMerge: true }}
    />
  );
}
