import { z } from "zod";

export const thumbnailSchema = z.object({
  title: z.string(),
  backgroundSrc: z.string().optional(),
  accentColor: z.string().default("#6366f1"),
});

export type ThumbnailProps = z.infer<typeof thumbnailSchema>;
