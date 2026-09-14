export interface SubscriptionNodeDto {
  machineId: string;
  name: string;
  address: string;
  region: string;
  tags: string[];
  protocols: ("trojan" | "hysteria2")[];
  configurationState: "pending" | "applied";
  available: boolean;
}
export interface SubscriptionDto {
  url: string;
  generation: number;
  credentialGeneration: number;
  configFormatVersion: string;
  blocked: boolean;
  blockReason: "disabled" | "quota" | null;
  nodes: SubscriptionNodeDto[];
  configJson: string;
}
