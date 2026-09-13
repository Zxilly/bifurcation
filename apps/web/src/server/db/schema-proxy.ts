import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./schema";
import { machines } from "./schema-machines";

export const proxyCredentials = sqliteTable("proxy_credentials", {
  userId: text("user_id").primaryKey().references(() => users.id),
  secretsCiphertext: text("secrets_ciphertext").notNull(),
  generation: integer("generation").notNull().default(1),
  changedAt: integer("changed_at").notNull(),
});
export const subscriptionTokens = sqliteTable("subscription_tokens", {
  userId: text("user_id").primaryKey().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  tokenCiphertext: text("token_ciphertext").notNull(),
  generation: integer("generation").notNull().default(1),
  changedAt: integer("changed_at").notNull(),
});
export const policyState = sqliteTable("policy_state", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  fingerprint: text("fingerprint").notNull(),
  period: text("period").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const machineConfigs = sqliteTable("machine_configs", {
  machineId: text("machine_id").primaryKey().references(() => machines.id),
  settingsCiphertext: text("settings_ciphertext"),
  version: integer("version").notNull().default(0),
  desiredRevisionId: text("desired_revision_id"),
  desiredPolicyRevision: integer("desired_policy_revision").notNull().default(0),
});
export const configPreviews = sqliteTable("config_previews", {
  id: text("id").primaryKey(),
  machineId: text("machine_id").notNull().references(() => machines.id),
  settingsCiphertext: text("settings_ciphertext").notNull(),
  renderedCiphertext: text("rendered_ciphertext").notNull(),
  digest: text("digest").notNull(),
  expectedVersion: integer("expected_version").notNull(),
  policyRevision: integer("policy_revision").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdBy: text("created_by").notNull().references(() => users.id),
  publishedRevisionId: text("published_revision_id"),
});
export const configRevisions = sqliteTable("config_revisions", {
  id: text("id").primaryKey(),
  machineId: text("machine_id").notNull().references(() => machines.id),
  version: integer("version").notNull(),
  settingsCiphertext: text("settings_ciphertext").notNull(),
  renderedCiphertext: text("rendered_ciphertext").notNull(),
  digest: text("digest").notNull(),
  policyRevision: integer("policy_revision").notNull(),
  authorizedUserIds: text("authorized_user_ids").notNull(),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by").references(() => users.id),
}, (table) => [uniqueIndex("configuration_machine_version").on(table.machineId, table.version)]);
export const machineUserHistory = sqliteTable("machine_user_history", {
  machineId: text("machine_id").notNull().references(() => machines.id),
  userId: text("user_id").notNull().references(() => users.id),
}, (table) => [primaryKey({ columns: [table.machineId, table.userId] })]);
export const usageStreams = sqliteTable("usage_streams", {
  machineId: text("machine_id").notNull().references(() => machines.id),
  installationId: text("installation_id").notNull(),
  streamId: text("stream_id").notNull(),
  committedSequence: text("committed_sequence").notNull(),
  lastPayloadHash: text("last_payload_hash").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
}, (table) => [primaryKey({ columns: [table.machineId, table.installationId, table.streamId] })]);
export const usageBuckets = sqliteTable("usage_buckets", {
  grain: text("grain", { enum: ["minute", "day", "month"] }).notNull(),
  bucketStart: integer("bucket_start").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  machineId: text("machine_id").notNull().references(() => machines.id),
  uploadBytes: text("upload_bytes").notNull(),
  downloadBytes: text("download_bytes").notNull(),
  estimated: integer("estimated", { mode: "boolean" }).notNull(),
  incomplete: integer("incomplete", { mode: "boolean" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.grain, table.bucketStart, table.userId, table.machineId] }),
  index("usage_user_time").on(table.userId, table.grain, table.bucketStart),
  index("usage_machine_time").on(table.machineId, table.grain, table.bucketStart),
]);
export const quotaStates = sqliteTable("quota_states", {
  userId: text("user_id").notNull().references(() => users.id),
  period: text("period").notNull(),
  usedBytes: text("used_bytes").notNull(),
  blocked: integer("blocked", { mode: "boolean" }).notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.period] })]);
