export type Role = "admin" | "user";
export type UserStatus = "pending" | "active" | "disabled";

export interface UserDto {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  monthlyLimitBytes: string | null;
  version: number;
  createdAt: number;
}

export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface PasskeyDto {
  id: string;
  name: string;
  createdAt: number;
  backedUp: boolean;
}

export interface MeDto {
  user: UserDto;
  authentication: "session" | "apiKey";
  recentAuthentication: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string; fields?: Record<string, string[]> };
}
