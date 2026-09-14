"use client";

import { LayerCard, Table } from "@cloudflare/kumo";
import { InlineEmpty } from "@/components/inline-empty";
import { Badge } from "@cloudflare/kumo/components/badge";
import type { UsageGroup } from "@bifurcation/rpc/panel/usage";
import { formatGiB, share } from "./format";

export function DataQuality({
  estimated,
  incomplete,
}: {
  estimated: boolean;
  incomplete: boolean;
}) {
  return (
    <>
      {incomplete && <Badge variant="destructive">统计不完整</Badge>}
      {estimated && <Badge variant="secondary">含估算</Badge>}
    </>
  );
}

type GroupRow = {
  id: string;
  name: string;
  uploadBytes: bigint;
  downloadBytes: bigint;
  estimated: boolean;
  incomplete: boolean;
};
function groupedUsage(groups: UsageGroup[], dimension: "user" | "machine") {
  const rows = new Map<string, GroupRow>();
  for (const group of groups) {
    const id = dimension === "user" ? group.userId : group.machineId;
    const row = rows.get(id) ?? {
      id,
      name: dimension === "user" ? group.username : group.machineName,
      uploadBytes: 0n,
      downloadBytes: 0n,
      estimated: false,
      incomplete: false,
    };
    row.uploadBytes += group.uploadBytes;
    row.downloadBytes += group.downloadBytes;
    row.estimated ||= group.estimated;
    row.incomplete ||= group.incomplete;
    rows.set(id, row);
  }
  return [...rows.values()].sort((a, b) => {
    const difference =
      b.uploadBytes + b.downloadBytes - a.uploadBytes - a.downloadBytes;
    return difference > 0n ? 1 : difference < 0n ? -1 : 0;
  });
}

export function GroupUsageTable({
  groups,
  dimension,
}: {
  groups: UsageGroup[];
  dimension: "user" | "machine";
}) {
  const rows = groupedUsage(groups, dimension);
  const total = rows.reduce(
    (sum, row) => sum + row.uploadBytes + row.downloadBytes,
    0n,
  );
  return (
    <LayerCard className="min-w-0 overflow-x-auto p-0">
      <Table className={rows.length ? "min-w-max tabular-nums" : "w-full"}>
        <Table.Header className={!rows.length ? "hidden" : undefined}>
          <Table.Row>
            <Table.Head>{dimension === "user" ? "用户" : "节点"}</Table.Head>
            <Table.Head className="text-right whitespace-nowrap">
              上传
            </Table.Head>
            <Table.Head className="text-right whitespace-nowrap">
              下载
            </Table.Head>
            <Table.Head className="text-right whitespace-nowrap">
              合计
            </Table.Head>
            <Table.Head className="text-right whitespace-nowrap">
              占比
            </Table.Head>
            <Table.Head>统计状态</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {!rows.length && (
            <Table.Row>
              <Table.Cell colSpan={6}>
                <InlineEmpty
                  title="暂无用量数据"
                  description="所选期间没有已上报明细，可调整时间范围后重试。"
                />
              </Table.Cell>
            </Table.Row>
          )}
          {rows.map((row) => (
            <Table.Row key={row.id}>
              <Table.Cell>{row.name}</Table.Cell>
              <Table.Cell className="text-right whitespace-nowrap">
                {formatGiB(row.uploadBytes)}
              </Table.Cell>
              <Table.Cell className="text-right whitespace-nowrap">
                {formatGiB(row.downloadBytes)}
              </Table.Cell>
              <Table.Cell className="text-right whitespace-nowrap">
                {formatGiB(row.uploadBytes + row.downloadBytes)}
              </Table.Cell>
              <Table.Cell className="text-right whitespace-nowrap">
                {share(row.uploadBytes + row.downloadBytes, total)}%
              </Table.Cell>
              <Table.Cell>
                <DataQuality
                  estimated={row.estimated}
                  incomplete={row.incomplete}
                />
                {!row.estimated && !row.incomplete && "完整"}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  );
}

export function UserMachineTable({ groups }: { groups: UsageGroup[] }) {
  return (
    <LayerCard className="min-w-0 overflow-x-auto p-0">
      <Table className={groups.length ? "min-w-max tabular-nums" : "w-full"}>
        <Table.Header className={!groups.length ? "hidden" : undefined}>
          <Table.Row>
            <Table.Head>用户</Table.Head>
            <Table.Head>节点</Table.Head>
            <Table.Head className="text-right whitespace-nowrap">
              上传
            </Table.Head>
            <Table.Head className="text-right whitespace-nowrap">
              下载
            </Table.Head>
            <Table.Head className="text-right whitespace-nowrap">
              合计
            </Table.Head>
            <Table.Head>统计状态</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {!groups.length && (
            <Table.Row>
              <Table.Cell colSpan={6}>
                <InlineEmpty
                  title="暂无用量数据"
                  description="所选期间没有已上报明细，可调整时间范围后重试。"
                />
              </Table.Cell>
            </Table.Row>
          )}
          {groups.map((row) => (
            <Table.Row key={`${row.userId}/${row.machineId}`}>
              <Table.Cell>{row.username}</Table.Cell>
              <Table.Cell>{row.machineName}</Table.Cell>
              <Table.Cell className="text-right whitespace-nowrap">
                {formatGiB(row.uploadBytes)}
              </Table.Cell>
              <Table.Cell className="text-right whitespace-nowrap">
                {formatGiB(row.downloadBytes)}
              </Table.Cell>
              <Table.Cell className="text-right whitespace-nowrap">
                {formatGiB(row.uploadBytes + row.downloadBytes)}
              </Table.Cell>
              <Table.Cell>
                <DataQuality
                  estimated={row.estimated}
                  incomplete={row.incomplete}
                />
                {!row.estimated && !row.incomplete && "完整"}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  );
}
