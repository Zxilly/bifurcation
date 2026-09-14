"use client";

import { Empty, Collapsible, LayerCard, Table } from "@cloudflare/kumo";
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
  if (!points.length)
    return (
      <Empty
        size="sm"
        className="rounded-none border-0 bg-transparent"
        title="所选期间暂无已上报用量"
        description="请调整时间范围，或检查节点上报。未上报不代表用量为零。"
      />
    );
  return (
    <>
      <UsageChart points={points} kind={kind} />
      <Collapsible.Root className="mt-5">
        <Collapsible.DefaultTrigger className="cursor-pointer subtle text-xs py-2">
          查看数值
        </Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <LayerCard className="min-w-0 overflow-x-auto p-0">
            <Table className="min-w-max tabular-nums">
              <Table.Header>
                <Table.Row>
                  <Table.Head>时间</Table.Head>
                  <Table.Head className="text-right whitespace-nowrap">
                    上传
                  </Table.Head>
                  <Table.Head className="text-right whitespace-nowrap">
                    下载
                  </Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {points.map((point, index) => (
                  <Table.Row key={`${point.label}-${index}`}>
                    <Table.Cell>{point.label}</Table.Cell>
                    <Table.Cell className="text-right whitespace-nowrap">
                      {point.uploadBytes === null
                        ? "无数据"
                        : formatGiB(point.uploadBytes)}
                    </Table.Cell>
                    <Table.Cell className="text-right whitespace-nowrap">
                      {point.downloadBytes === null
                        ? "无数据"
                        : formatGiB(point.downloadBytes)}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
    </>
  );
}
