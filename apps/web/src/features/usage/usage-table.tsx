"use client";

import { Badge } from "@cloudflare/kumo/components/badge";
import type { UsageGroupDto } from "@/contracts/usage";
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
function groupedUsage(groups: UsageGroupDto[], dimension: "user" | "machine") {
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
    row.uploadBytes += BigInt(group.uploadBytes);
    row.downloadBytes += BigInt(group.downloadBytes);
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
  groups: UsageGroupDto[];
  dimension: "user" | "machine";
}) {
  const rows = groupedUsage(groups, dimension);
  const total = rows.reduce(
    (sum, row) => sum + row.uploadBytes + row.downloadBytes,
    0n,
  );
  if (!rows.length) return <p className="empty-state">暂无用量数据</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{dimension === "user" ? "用户" : "节点"}</th>
            <th>上传</th>
            <th>下载</th>
            <th>合计</th>
            <th>占比</th>
            <th>统计状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td>{formatGiB(row.uploadBytes)}</td>
              <td>{formatGiB(row.downloadBytes)}</td>
              <td>{formatGiB(row.uploadBytes + row.downloadBytes)}</td>
              <td>{share(row.uploadBytes + row.downloadBytes, total)}%</td>
              <td>
                <DataQuality
                  estimated={row.estimated}
                  incomplete={row.incomplete}
                />
                {!row.estimated && !row.incomplete && "完整"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UserMachineTable({ groups }: { groups: UsageGroupDto[] }) {
  if (!groups.length) return <p className="empty-state">暂无用量数据</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>用户</th>
            <th>节点</th>
            <th>上传</th>
            <th>下载</th>
            <th>合计</th>
            <th>统计状态</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((row) => (
            <tr key={`${row.userId}/${row.machineId}`}>
              <td>{row.username}</td>
              <td>{row.machineName}</td>
              <td>{formatGiB(row.uploadBytes)}</td>
              <td>{formatGiB(row.downloadBytes)}</td>
              <td>
                {formatGiB(BigInt(row.uploadBytes) + BigInt(row.downloadBytes))}
              </td>
              <td>
                <DataQuality
                  estimated={row.estimated}
                  incomplete={row.incomplete}
                />
                {!row.estimated && !row.incomplete && "完整"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
