import type { TaskDto } from "./machines";

export type TlsSettings =
  | { mode: "pem"; serverName: string; certificatePem: string; privateKeyPem: string }
  | { mode: "path"; serverName: string; certificatePath: string; privateKeyPath: string }
  | { mode: "acme"; serverName: string; email: string };

export interface MachineConfigurationInput {
  listen?: string;
  trojanPort: number;
  hysteria2Port: number;
  tls: TlsSettings;
  /** Administrator-controlled base options; managed listeners and authorization are protected. */
  baseJson: Record<string, unknown>;
}
export interface ConfigurationPreviewDto {
  previewId: string;
  expectedVersion: number;
  policyRevision: string;
  digest: string;
  finalJson: string;
  expiresAt: number;
}
export interface MachineConfigurationDto {
  settings: MachineConfigurationInput | null;
  version: number;
  desiredRevisionId: string | null;
  desiredPolicyRevision: string | null;
  appliedRevisionId: string | null;
  appliedPolicyRevision: string | null;
  reconciliation: "not_configured" | "pending" | "applied" | "failed";
  latestTask: TaskDto | null;
  bundledCoreVersion: string | null;
}
export interface ConfigurationPublishDto {
  revisionId: string;
  version: number;
  task: TaskDto;
}
export interface AuthorizationLayer {
  version: 1;
  policyRevision: string;
  users: { id: string; trojanPassword: string; hysteria2Password: string }[];
}
