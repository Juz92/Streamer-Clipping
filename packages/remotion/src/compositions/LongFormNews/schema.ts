import { z } from "zod";

const captionWordSchema = z.object({
  word: z.string(),
  startMs: z.number(),
  endMs: z.number(),
});

const shotSchema = z.object({
  id: z.string(),
  type: z.enum(["screenshot", "text_card", "browser_recording"]),
  src: z.string().optional(),
  caption: z.string().optional(),
  heading: z.string().optional(),
  body: z.string().optional(),
  durationFrames: z.number(),
  kenBurns: z
    .object({
      startScale: z.number().optional(),
      endScale: z.number().optional(),
      startX: z.number().optional(),
      startY: z.number().optional(),
      endX: z.number().optional(),
      endY: z.number().optional(),
    })
    .optional(),
});

export const longFormNewsSchema = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  shots: z.array(shotSchema),
  audioSrc: z.string().optional(),
  captionWords: z.array(captionWordSchema).optional(),
  titleDurationFrames: z.number().default(150),
  ctaDurationFrames: z.number().default(150),
});

export type LongFormNewsProps = z.infer<typeof longFormNewsSchema>;
export type ShotInput = z.infer<typeof shotSchema>;
