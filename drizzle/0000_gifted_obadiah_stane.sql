CREATE TABLE `events` (
	`time` integer DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`type` text NOT NULL,
	`payload` blob NOT NULL,
	`guild_id` text GENERATED ALWAYS AS (payload -> 'guild_id') STORED
);
--> statement-breakpoint
CREATE INDEX `idx_event_type` ON `events` (`type`);--> statement-breakpoint
CREATE INDEX `idx_event_guild_id` ON `events` (`guild_id`);