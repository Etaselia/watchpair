CREATE TABLE `watch_participants` (
	`session_token` text NOT NULL,
	`device_id` text NOT NULL,
	`name` text NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_token`, `device_id`)
);
--> statement-breakpoint
CREATE TABLE `watch_sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`source_json` text,
	`selected_media_json` text,
	`player_json` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
