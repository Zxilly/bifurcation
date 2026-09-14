CREATE TABLE `subscription_previews` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`version` integer NOT NULL,
	`digest` text NOT NULL,
	`expires_at` integer NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`preset` text NOT NULL,
	`request_key` text NOT NULL,
	`draft_ciphertext` text NOT NULL,
	`published_ciphertext` text,
	`version` integer DEFAULT 1 NOT NULL,
	`published_version` integer DEFAULT 0 NOT NULL,
	`legacy` integer DEFAULT false NOT NULL,
	`token_hash` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_fetched_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_token_hash_unique` ON `subscriptions` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_create_key` ON `subscriptions` (`user_id`,`request_key`);--> statement-breakpoint
ALTER TABLE `machines` ADD `tags` text DEFAULT '[]' NOT NULL;