export interface UsagePointDto {
  bucketStart: number;
  uploadBytes: string;
  downloadBytes: string;
  estimated: boolean;
  incomplete: boolean;
}
export interface UsageGroupDto {
  userId: string;
  username: string;
  machineId: string;
  machineName: string;
  uploadBytes: string;
  downloadBytes: string;
  estimated: boolean;
  incomplete: boolean;
}
export interface UsageDto {
  start: number;
  end: number;
  grain: "minute" | "day" | "month";
  uploadBytes: string;
  downloadBytes: string;
  estimated: boolean;
  incomplete: boolean;
  points: UsagePointDto[];
  groups: UsageGroupDto[];
  currentMonth: { period: string; usedBytes: string; limitBytes: string | null; blocked: boolean; warning: "80" | "95" | "100" | null } | null;
  /** Largest received minute total divided by 60; null for missing/expired/incomplete minute data. */
  peakMinuteAverageBytesPerSecond: number | null;
  previousPeriod: {
    previousStart: number;
    previousEnd: number;
    uploadBytes: string;
    downloadBytes: string;
    hasData: boolean;
    incomplete: boolean;
    currentPeriodInProgress: boolean;
    /** Total-byte change, rounded to two decimals; absent for unfinished/unreliable comparisons. */
    changePercent: number | null;
  };
}
