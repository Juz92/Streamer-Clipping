import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const ideas = sqliteTable("ideas", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceUrlHash: text("source_url_hash").notNull().unique(),
  sourceName: text("source_name").notNull(),
  discoveredAt: text("discovered_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  noveltyScore: real("novelty_score").default(0),
  impactScore: real("impact_score").default(0),
  audienceScore: real("audience_score").default(0),
  compositeScore: real("composite_score").default(0),
  status: text("status", {
    enum: ["new", "ranked", "selected", "rejected"],
  })
    .notNull()
    .default("new"),
}, (table) => ([
  index("idx_ideas_status_score").on(table.status, table.compositeScore),
]));

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ideaId: integer("idea_id")
    .notNull()
    .references(() => ideas.id),
  state: text("state", {
    enum: [
      "discovered",
      "ranked",
      "selected",
      "scripted",
      "visual_planned",
      "assets_captured",
      "voiced",
      "rendered",
      "uploaded_private",
      "scheduled",
      "published",
      "failed",
    ],
  })
    .notNull()
    .default("selected"),
  retryFromState: text("retry_from_state"),
  videoFormat: text("video_format", {
    enum: ["long_form", "short_form"],
  })
    .notNull()
    .default("short_form"),
  targetPlatform: text("target_platform", {
    enum: ["youtube_shorts", "tiktok", "instagram_reels", "all"],
  })
    .notNull()
    .default("all"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
}, (table) => ([
  index("idx_jobs_state").on(table.state),
]));

export const scripts = sqliteTable("scripts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobs.id)
    .unique(),
  hookText: text("hook_text").notNull(),
  sections: text("sections", { mode: "json" }).notNull(),
  fullNarration: text("full_narration").notNull(),
  youtubeTitle: text("youtube_title").notNull(),
  youtubeDescription: text("youtube_description").notNull(),
  youtubeTags: text("youtube_tags", { mode: "json" }).notNull(),
  tiktokCaption: text("tiktok_caption"),
  instagramCaption: text("instagram_caption"),
  pinnedComment: text("pinned_comment"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const visualPlans = sqliteTable("visual_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobs.id)
    .unique(),
  shots: text("shots", { mode: "json" }).notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const assets = sqliteTable("assets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobs.id),
  shotId: text("shot_id"),
  type: text("type", {
    enum: [
      "screenshot",
      "recording",
      "audio",
      "srt",
      "rendered_video",
      "thumbnail",
      "still_image",
      "map",
      "timeline",
      "badge",
      "broll_video",
      "music",
    ],
  }).notNull(),
  filePath: text("file_path").notNull(),
  durationMs: integer("duration_ms"),
  attribution: text("attribution"),
  sourceUrl: text("source_url"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const uploads = sqliteTable("uploads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobs.id)
    .unique(),
  youtubeVideoId: text("youtube_video_id").notNull(),
  privacyStatus: text("privacy_status", {
    enum: ["private", "unlisted", "public"],
  })
    .notNull()
    .default("private"),
  scheduledPublishAt: text("scheduled_publish_at"),
  platform: text("platform", {
    enum: ["youtube", "tiktok", "instagram"],
  })
    .notNull()
    .default("youtube"),
  uploadedAt: text("uploaded_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const comments = sqliteTable("comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uploadId: integer("upload_id")
    .notNull()
    .references(() => uploads.id),
  youtubeCommentId: text("youtube_comment_id").notNull().unique(),
  authorName: text("author_name").notNull(),
  text: text("text").notNull(),
  classification: text("classification", {
    enum: ["positive", "question", "constructive", "spam", "negative", "suggestion"],
  }),
  replyDraft: text("reply_draft"),
  replyStatus: text("reply_status", {
    enum: ["pending", "approved", "posted", "skipped"],
  }).default("pending"),
  fetchedAt: text("fetched_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const analytics = sqliteTable("analytics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobs.id),
  platform: text("platform", {
    enum: ["youtube", "tiktok", "instagram"],
  }).notNull(),
  views: integer("views").default(0),
  watchTimeMinutes: real("watch_time_minutes").default(0),
  avgViewDurationSec: real("avg_view_duration_sec").default(0),
  likes: integer("likes").default(0),
  comments: integer("comments").default(0),
  shares: integer("shares").default(0),
  ctr: real("ctr").default(0),
  impressions: integer("impressions").default(0),
  subscribersGained: integer("subscribers_gained").default(0),
  subscribersLost: integer("subscribers_lost").default(0),
  estimatedRetentionPct: real("estimated_retention_pct").default(0),
  trafficSource: text("traffic_source"),
  avgViewPct: real("avg_view_pct").default(0),
  videoAgeHours: real("video_age_hours").default(0),
  fetchedAt: text("fetched_at")
    .notNull()
    .default(sql`(datetime('now'))`),
}, (table) => ([
  index("idx_analytics_job_platform").on(table.jobId, table.platform),
]));

