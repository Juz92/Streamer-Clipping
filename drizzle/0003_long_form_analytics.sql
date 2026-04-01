ALTER TABLE `scripts` ADD `pinned_comment` text;--> statement-breakpoint
CREATE TABLE `analytics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL REFERENCES jobs(id),
	`platform` text NOT NULL,
	`views` integer DEFAULT 0,
	`watch_time_minutes` real DEFAULT 0,
	`avg_view_duration_sec` real DEFAULT 0,
	`likes` integer DEFAULT 0,
	`comments` integer DEFAULT 0,
	`shares` integer DEFAULT 0,
	`ctr` real DEFAULT 0,
	`fetched_at` text DEFAULT (datetime('now')) NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_analytics_job_platform` ON `analytics` (`job_id`, `platform`);
