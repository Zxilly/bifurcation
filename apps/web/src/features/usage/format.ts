const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

export function gib(bytes: string | number | bigint): number {
  return Number(bytes) / 1_073_741_824;
}

export function formatGiB(bytes: string | number | bigint): string {
  const value = gib(bytes);
  return value > 0 && value < 0.01
    ? "<0.01 GiB"
    : `${number.format(value)} GiB`;
}

export function formatRate(bytesPerSecond: string | number | bigint): string {
  const value = Number(bytesPerSecond);
  if (value >= 1_048_576) return `${number.format(value / 1_048_576)} MiB/s`;
  if (value >= 1_024) return `${number.format(value / 1_024)} KiB/s`;
  return `${number.format(value)} B/s`;
}

export function formatBytes(bytes: string | number | bigint): string {
  const value = Number(bytes);
  if (value >= 1_073_741_824) return formatGiB(bytes);
  if (value >= 1_048_576) return `${number.format(value / 1_048_576)} MiB`;
  if (value >= 1_024) return `${number.format(value / 1_024)} KiB`;
  return `${number.format(value)} B`;
}

export function share(bytes: string | bigint, total: string | bigint): number {
  const denominator = BigInt(total);
  if (denominator === 0n) return 0;
  return Number((BigInt(bytes) * 10_000n) / denominator) / 100;
}
