-- Autoresearch experiment tracking tables

CREATE TABLE `experiments` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `job_id` integer REFERENCES `jobs`(`id`),
  `experiment_number` integer NOT NULL,
  `experiment_type` text NOT NULL DEFAULT 'full',
  `hypothesis` text NOT NULL,
  `variables_changed` text NOT NULL,
  `baseline_job_id` integer REFERENCES `jobs`(`id`),

  -- Outcome metrics (filled after 24-48h measurement)
  `stay_rate` real,
  `avg_view_pct` real,
  `like_rate` real,
  `comment_rate` real,
  `views` integer,
  `viral_score` real,

  -- Retention curve checkpoints
  `ret_3s` real,
  `ret_15s` real,
  `ret_30s` real,
  `ret_45s` real,
  `ret_60s` real,

  -- Deltas from baseline
  `stay_rate_delta` real,
  `viral_score_delta` real,

  -- Comment + trend tracking
  `comment_strategy` text,
  `trending_context` text,
  `trend_score` integer,

  -- Verdict
  `status` text NOT NULL DEFAULT 'planned',
  `learnings_summary` text,
  `confidence_level` text,

  -- Probe promotion link
  `promoted_to_exp_id` integer,

  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `measured_at` text
);

CREATE INDEX `idx_experiments_job` ON `experiments` (`job_id`);
CREATE INDEX `idx_experiments_status` ON `experiments` (`status`);

CREATE TABLE `learnings` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `experiment_id` integer REFERENCES `experiments`(`id`),
  `rule` text NOT NULL,
  `evidence` text NOT NULL,
  `confidence` text NOT NULL,
  `category` text NOT NULL,
  `impact` text NOT NULL,
  `active` integer NOT NULL DEFAULT 1,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `superseded_by` integer
);
