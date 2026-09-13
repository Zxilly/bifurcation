CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_token_hash_unique` ON `api_keys` (`token_hash`);--> statement-breakpoint
CREATE TABLE `auth_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`user_id` text,
	`token_hash` text,
	`challenge` text,
	`session_hash` text,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_flows_token_hash_unique` ON `auth_flows` (`token_hash`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`transports` text NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `password_credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`changed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`resets_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`reauth_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`monthly_limit_bytes` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text NOT NULL,
	`region` text DEFAULT '' NOT NULL,
	`token_hash` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`token_generation` integer DEFAULT 1 NOT NULL,
	`installation_id` text,
	`binding_epoch` integer DEFAULT 0 NOT NULL,
	`session_epoch` integer DEFAULT 0 NOT NULL,
	`status_sequence` integer DEFAULT 0 NOT NULL,
	`status_json` text,
	`supported_tasks` text DEFAULT '[]' NOT NULL,
	`daemon_version` text,
	`os` text,
	`arch` text,
	`last_seen_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`removed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machines_token_hash_unique` ON `machines` (`token_hash`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`binding_epoch` integer NOT NULL,
	`kind` integer NOT NULL,
	`payload` blob NOT NULL,
	`payload_hash` text NOT NULL,
	`request_key` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`progress_sequence` integer DEFAULT 0 NOT NULL,
	`report_hash` text,
	`phase` text,
	`progress_percent` integer,
	`message` text,
	`error_code` text,
	`diagnostic_json` text,
	`rollback` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_request_key` ON `tasks` (`machine_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `task_delivery` ON `tasks` (`machine_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `config_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`settings_ciphertext` text NOT NULL,
	`rendered_ciphertext` text NOT NULL,
	`digest` text NOT NULL,
	`expected_version` integer NOT NULL,
	`policy_revision` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`published_revision_id` text,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `config_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`version` integer NOT NULL,
	`settings_ciphertext` text NOT NULL,
	`rendered_ciphertext` text NOT NULL,
	`digest` text NOT NULL,
	`policy_revision` integer NOT NULL,
	`authorized_user_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `configuration_machine_version` ON `config_revisions` (`machine_id`,`version`);--> statement-breakpoint
CREATE TABLE `machine_configs` (
	`machine_id` text PRIMARY KEY NOT NULL,
	`settings_ciphertext` text,
	`version` integer DEFAULT 0 NOT NULL,
	`desired_revision_id` text,
	`desired_policy_revision` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `machine_user_history` (
	`machine_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`machine_id`, `user_id`),
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `policy_state` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`period` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proxy_credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secrets_ciphertext` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`changed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `quota_states` (
	`user_id` text NOT NULL,
	`period` text NOT NULL,
	`used_bytes` text NOT NULL,
	`blocked` integer NOT NULL,
	PRIMARY KEY(`user_id`, `period`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `subscription_tokens` (
	`user_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`changed_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_tokens_token_hash_unique` ON `subscription_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `usage_buckets` (
	`grain` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`user_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`upload_bytes` text NOT NULL,
	`download_bytes` text NOT NULL,
	`estimated` integer NOT NULL,
	`incomplete` integer NOT NULL,
	PRIMARY KEY(`grain`, `bucket_start`, `user_id`, `machine_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `usage_user_time` ON `usage_buckets` (`user_id`,`grain`,`bucket_start`);--> statement-breakpoint
CREATE INDEX `usage_machine_time` ON `usage_buckets` (`machine_id`,`grain`,`bucket_start`);--> statement-breakpoint
CREATE TABLE `usage_streams` (
	`machine_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`stream_id` text NOT NULL,
	`committed_sequence` text NOT NULL,
	`last_payload_hash` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`machine_id`, `installation_id`, `stream_id`),
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
