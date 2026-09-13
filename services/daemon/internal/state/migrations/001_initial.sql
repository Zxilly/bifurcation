PRAGMA foreign_keys = off;
CREATE TABLE `batches` (`id` text NOT NULL, `seq` integer NOT NULL, `stream_id` text NOT NULL, `size_bytes` integer NOT NULL DEFAULT (0), `payload` blob NOT NULL, `payload_hash` text NOT NULL, PRIMARY KEY (`id`));
CREATE UNIQUE INDEX `batch_stream_id_seq` ON `batches` (`stream_id`, `seq`);
CREATE TABLE `cores` (`id` text NOT NULL, `policy_floor` integer NOT NULL DEFAULT (0), `authorization` blob NULL, `applied_revision` text NOT NULL DEFAULT (''), `applied_policy` integer NOT NULL DEFAULT (0), `applied_config` blob NULL, `stage` text NOT NULL DEFAULT ('idle'), `pending_task` text NOT NULL DEFAULT (''), `pending_revision` text NOT NULL DEFAULT (''), `pending_policy` integer NOT NULL DEFAULT (0), `pending_config` blob NULL, PRIMARY KEY (`id`));
CREATE TABLE `cursors` (`id` text NOT NULL, `runtime_id` text NOT NULL, `upload` integer NOT NULL, `download` integer NOT NULL, `observed_at` integer NOT NULL, `closed` bool NOT NULL DEFAULT (false), PRIMARY KEY (`id`));
CREATE TABLE `streams` (`id` text NOT NULL, `next_seq` integer NOT NULL DEFAULT (1), `committed_seq` integer NOT NULL DEFAULT (0), `pending_bytes` integer NOT NULL DEFAULT (0), `recovery_issue` text NOT NULL DEFAULT (''), PRIMARY KEY (`id`));
CREATE TABLE `tasks` (`id` text NOT NULL, `payload_hash` text NOT NULL, `kind` text NOT NULL, `payload` blob NOT NULL, `binding_epoch` integer NOT NULL, `status` text NOT NULL DEFAULT ('accepted'), `progress_seq` integer NOT NULL DEFAULT (0), `result` blob NULL, `acknowledged` bool NOT NULL DEFAULT (false), PRIMARY KEY (`id`));
PRAGMA foreign_keys = on;
