import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
export * from "./schema-machines";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  role: text("role", { enum: ["admin", "user"] }).notNull(),
  status: text("status", { enum: ["pending", "active", "disabled"] }).notNull(),
  monthlyLimitBytes: text("monthly_limit_bytes"),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at").notNull(),
});
export const passwords = sqliteTable("password_credentials", {
  userId: text("user_id").primaryKey().references(() => users.id),
  hash: text("hash").notNull(),
  changedAt: integer("changed_at").notNull(),
});
export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  expiresAt: integer("expires_at").notNull(),
  reauthAt: integer("reauth_at").notNull(),
});
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
});
export const passkeys = sqliteTable("passkeys", {
  id: text("credential_id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull(),
  transports: text("transports").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const authFlows = sqliteTable("auth_flows", {
  id: text("id").primaryKey(),
  purpose: text("purpose", { enum: ["activation", "recovery", "login", "register", "reauth"] }).notNull(),
  userId: text("user_id").references(() => users.id),
  tokenHash: text("token_hash").unique(),
  challenge: text("challenge"),
  sessionHash: text("session_hash"),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
});
export const rateLimits = sqliteTable("rate_limits", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  resetsAt: integer("resets_at").notNull(),
});
export * from "./schema-proxy";
