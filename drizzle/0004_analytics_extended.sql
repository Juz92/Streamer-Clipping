ALTER TABLE `analytics` ADD `impressions` integer DEFAULT 0;
ALTER TABLE `analytics` ADD `subscribers_gained` integer DEFAULT 0;
ALTER TABLE `analytics` ADD `subscribers_lost` integer DEFAULT 0;
ALTER TABLE `analytics` ADD `estimated_retention_pct` real DEFAULT 0;
ALTER TABLE `analytics` ADD `traffic_source` text;
ALTER TABLE `analytics` ADD `avg_view_pct` real DEFAULT 0;
ALTER TABLE `analytics` ADD `video_age_hours` real DEFAULT 0;
