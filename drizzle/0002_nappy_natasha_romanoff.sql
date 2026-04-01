CREATE TABLE `players` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`full_name` text NOT NULL,
	`short_name` text NOT NULL,
	`slug` text NOT NULL,
	`nationality` text,
	`birth_date` text,
	`birth_place` text,
	`positions` text,
	`current_club` text,
	`notable_clubs` text,
	`wikipedia_url` text,
	`wikidata_id` text,
	`image_url` text,
	`image_attribution` text,
	`stories_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `players_slug_unique` ON `players` (`slug`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `target_platform` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `assets` ADD `attribution` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `ideas` ADD `player_id` integer REFERENCES players(id);--> statement-breakpoint
ALTER TABLE `ideas` ADD `content_pillar` text;--> statement-breakpoint
ALTER TABLE `ideas` ADD `series_format` text;--> statement-breakpoint
ALTER TABLE `ideas` ADD `story_angle` text;--> statement-breakpoint
ALTER TABLE `ideas` ADD `fact_check_status` text DEFAULT 'unverified';--> statement-breakpoint
ALTER TABLE `scripts` ADD `tiktok_caption` text;--> statement-breakpoint
ALTER TABLE `scripts` ADD `instagram_caption` text;--> statement-breakpoint
ALTER TABLE `uploads` ADD `platform` text DEFAULT 'youtube' NOT NULL;