import { z } from "zod";

const regionSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const captionWordSchema = z.object({
  word: z.string(),
  startMs: z.number(),
  endMs: z.number(),
});

export const gamingShortSchema = z.object({
  clipSrc: z.string(),
  layoutMode: z.enum(["gameplay", "talking"]),
  avatarRegion: regionSchema,
  gameplayRegion: regionSchema.optional(),
  captionWords: z.array(captionWordSchema).optional(),
  durationFrames: z.number().optional(),
  title: z.string().optional(),
});

export type GamingShortProps = z.infer<typeof gamingShortSchema>;
