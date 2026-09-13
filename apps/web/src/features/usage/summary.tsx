import { formatGiB, formatRate } from "./format";

const date = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Shanghai",
});
const percent = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

export function UsageSummary({
  peak,
  previous,
  changePercent,
  currentIncomplete,
  currentInProgress,
}: {
  peak: number | null;
  previous: {
    start: number;
    end: number;
    bytes: string | null;
    incomplete: boolean;
  };
  changePercent: number | null;
  currentIncomplete: boolean;
  currentInProgress: boolean;
}) {
  const change =
    changePercent !== null
      ? `${percent.format(changePercent)}%`
      : currentInProgress
        ? "当前周期未结束"
        : currentIncomplete || previous.incomplete
          ? "统计不完整，暂不比较"
          : previous.bytes === null
            ? "上期无数据"
            : BigInt(previous.bytes) === 0n
              ? "上期用量为 0"
              : "暂不可比较";
  return (
    <dl className="grid gap-4 sm:grid-cols-3 my-5 text-sm">
      <div>
        <dt className="subtle mb-1">分钟平均峰值</dt>
        <dd className="font-semibold tabular-nums">
          {peak === null ? "暂无完整分钟数据" : formatRate(peak)}
        </dd>
      </div>
      <div>
        <dt className="subtle mb-1">上一周期用量</dt>
        <dd className="font-semibold tabular-nums">
          {previous.bytes === null ? "暂无数据" : formatGiB(previous.bytes)}
        </dd>
        <dd className="subtle text-xs mt-1">
          {date.format(previous.start)} — {date.format(previous.end - 1)}
        </dd>
        {previous.incomplete && previous.bytes !== null && (
          <dd className="subtle text-xs mt-1">上期统计不完整</dd>
        )}
      </div>
      <div>
        <dt className="subtle mb-1">较上一周期</dt>
        <dd className="font-semibold tabular-nums">{change}</dd>
      </div>
    </dl>
  );
}
