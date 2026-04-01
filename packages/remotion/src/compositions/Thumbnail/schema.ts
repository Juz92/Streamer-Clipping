import { z } from "zod";

export const thumbnailSchema = z.object({
  title: z.string(),
  backgroundSrc: z.string().optional(),
  accentColor: z.string().optional(),
  variant: z
    .enum(["default", "bold", "minimal", "comparison", "story"])
    .optional(),
  leftLabel: z.string().optional(),
  rightLabel: z.string().optional(),
  leftSrc: z.string().optional(),
  rightSrc: z.string().optional(),
  playerImageSrc: z.string().optional(),
  seriesBadge: z.string().optional(),
});

export type ThumbnailProps = z.infer<typeof thumbnailSchema>;
