CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`shot_id` text,
	`type` text NOT NULL,
	`file_path` text NOT NULL,
	`duration_ms` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`upload_id` integer NOT NULL,
	`youtube_comment_id` text NOT NULL,
	`author_name` text NOT NULL,
	`text` text NOT NULL,
	`classification` text,
	`reply_draft` text,
	`reply_status` text DEFAULT 'pending',
	`fetched_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comments_youtube_comment_id_unique` ON `comments` (`youtube_comment_id`);--> statement-breakpoint
CREATE TABLE `ideas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`source_url` text NOT NULL,
	`source_url_hash` text NOT NULL,
	`source_name` text NOT NULL,
	`discovered_at` text DEFAULT (datetime('now')) NOT NULL,
	`novelty_score` real DEFAULT 0,
	`impact_score` real DEFAULT 0,
	`audience_score` real DEFAULT 0,
	`composite_score` real DEFAULT 0,
	`status` text DEFAULT 'new' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ideas_source_url_hash_unique` ON `ideas` (`source_url_hash`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`idea_id` integer NOT NULL,
	`state` text DEFAULT 'selected' NOT NULL,
	`retry_from_state` text,
	`video_format` text DEFAULT 'long_form' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`idea_id`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scripts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`hook_text` text NOT NULL,
	`sections` text NOT NULL,
	`full_narration` text NOT NULL,
	`youtube_title` text NOT NULL,
	`youtube_description` text NOT NULL,
	`youtube_tags` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scripts_job_id_unique` ON `scripts` (`job_id`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`youtube_video_id` text NOT NULL,
	`privacy_status` text DEFAULT 'private' NOT NULL,
	`scheduled_publish_at` text,
	`uploaded_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_job_id_unique` ON `uploads` (`job_id`);--> statement-breakpoint
CREATE TABLE `visual_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`shots` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visual_plans_job_id_unique` ON `visual_plans` (`job_id`);