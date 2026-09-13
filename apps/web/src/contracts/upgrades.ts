import type { TaskDto } from "./machines";

export interface UpgradeCandidateDto {
  currentVersion: string | null;
  availableVersion: string | null;
  sha256: string | null;
  sizeBytes: string | null;
  executable: boolean;
  disabledReason: string | null;
  sameVersion: boolean;
}
export interface MachineUpgradesDto {
  machineId: string;
  bundledCoreVersion: string | null;
  availableBundledCoreVersion: string | null;
  daemon: UpgradeCandidateDto;
  activeTask: TaskDto | null;
}
export interface UpgradeResultDto {
  task: TaskDto;
}
