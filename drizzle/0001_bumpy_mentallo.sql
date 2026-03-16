CREATE INDEX `idx_ideas_status_score` ON `ideas` (`status`,`composite_score`);--> statement-breakpoint
CREATE INDEX `idx_jobs_state` ON `jobs` (`state`);