CREATE TABLE `watch_voice_signals` (
	`session_token` text NOT NULL,
	`id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`signal_type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_token`, `id`)
);
--> statement-breakpoint
CREATE INDEX `watch_voice_signals_recipient_idx` ON `watch_voice_signals` (`session_token`,`to_id`,`created_at`);