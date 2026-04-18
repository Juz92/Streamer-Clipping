# Sprint 2: Remotion Polish + Short-Form Templates

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Elevate LongFormNews visual quality with transitions, overlays, and new scenes; add ShortForm (9:16) composition for Shorts/TikTok; add thumbnail style variants.

**Architecture:** All changes in `packages/remotion/src/`. New components are self-contained React+Remotion modules. LongFormNews gets transition wrapping, progress bar overlay, and lower-third source attribution. New ShortForm composition reuses Caption, KenBurns, and new components. Thumbnail gets variant support. Schema changes propagate to render.ts.

**Tech Stack:** Remotion 4.x, React, Zod, TypeScript

---

## Context

Sprint 1 delivered a working end-to-end pipeline producing a 19.9 MB MP4 video. The LongFormNews template works but looks plain — no transitions between shots, no progress indicator, no source attribution. The TransitionWipe component exists but is unused. There's no short-form (9:16) composition for YouTube Shorts or TikTok. Thumbnails have one style. This sprint adds visual polish and new composition types.

### Existing Files (read these before editing)
- `packages/remotion/src/Root.tsx` — composition registrations
- `packages/remotion/src/compositions/LongFormNews/index.tsx` — main composition
- `packages/remotion/src/compositions/LongFormNews/schema.ts` — Zod schema
- `packages/remotion/src/compositions/LongFormNews/scenes/` — TitleCard, Screenshot, TextCard, CTA
- `packages/remotion/src/compositions/Thumbnail/index.tsx` — thumbnail still
- `packages/remotion/src/compositions/Thumbnail/schema.ts` — thumbnail schema
- `packages/remotion/src/components/` — Caption, KenBurns, TransitionWipe
- `packages/remotion/src/styles/theme.ts` — design tokens
- `packages/remotion/src/lib/captions.ts` — caption grouping utils
- `packages/pipeline/src/render.ts` — Remotion CLI render invocation

### Key Remotion Patterns
- `useCurrentFrame()` + `useVideoConfig()` for animation state
- `interpolate()` for linear mapping, `spring()` for physics-based
- `<Sequence>` for timeline placement, `<AbsoluteFill>` for stacking
- `staticFile()` for all media refs (resolved via `--public-dir`)
- `<Img>` from remotion for images, `<Video>` for video clips
- `<Audio>` for audio, supports `startFrom` and `volume`
- Zod schemas define `defaultProps` and validate render-time input

---

## Task 1: Fade Transition Component

**Files:**
- Create: `packages/remotion/src/components/Fade.tsx`

**Steps:**

1. Create `packages/remotion/src/components/Fade.tsx`:

```tsx
import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface FadeProps {
  children: React.ReactNode;
  enterDurationFrames?: number;
  exitDurationFrames?: number;
}

export const Fade: React.FC<FadeProps> = ({
  children,
  enterDurationFrames = 10,
  exitDurationFrames = 10,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const enterOpacity = interpolate(frame, [0, enterDurationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const exitStart = durationInFrames - exitDurationFrames;
  const exitOpacity = interpolate(
    frame,
    [exitStart, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const opacity = Math.min(enterOpacity, exitOpacity);

  return <div style={{ width: "100%", height: "100%", opacity }}>{children}</div>;
};
```

2. Verify: Run `npx remotion studio` from `packages/remotion`, confirm no build errors.

3. Commit: `feat(remotion): add Fade transition component`

---

## Task 2: Integrate Transitions into LongFormNews

**Files:**
- Modify: `packages/remotion/src/compositions/LongFormNews/index.tsx`
- Modify: `packages/remotion/src/compositions/LongFormNews/schema.ts`

**Steps:**

1. Update `schema.ts` — add optional `transition` field to shot schema:

```ts
// Add to shotSchema, after kenBurns:
transition: z
  .enum(["none", "fade", "wipe-left", "wipe-right", "wipe-up", "wipe-down"])
  .default("fade"),
```

2. Update `index.tsx` — import Fade and TransitionWipe, wrap each shot's render output:

```tsx
// Add imports:
import { Fade } from "../../components/Fade";
import { TransitionWipe } from "../../components/TransitionWipe";

// Replace the renderShot function with a new renderShotWithTransition:
function wrapWithTransition(
  content: React.ReactNode,
  transition: string
): React.ReactNode {
  if (!content) return null;
  switch (transition) {
    case "fade":
      return <Fade>{content}</Fade>;
    case "wipe-left":
      return <TransitionWipe direction="left">{content}</TransitionWipe>;
    case "wipe-right":
      return <TransitionWipe direction="right">{content}</TransitionWipe>;
    case "wipe-up":
      return <TransitionWipe direction="up">{content}</TransitionWipe>;
    case "wipe-down":
      return <TransitionWipe direction="down">{content}</TransitionWipe>;
    case "none":
    default:
      return content;
  }
}
```

3. In the shotSequences map, call `wrapWithTransition(renderShot(shot), shot.transition ?? "fade")` instead of just `renderShot(shot)`.

4. Verify: `npx remotion studio` — preview LongFormNews, shots should fade in/out between each other.

5. Commit: `feat(remotion): integrate fade/wipe transitions into LongFormNews`

---

## Task 3: ProgressBar Component

**Files:**
- Create: `packages/remotion/src/components/ProgressBar.tsx`

**Steps:**

1. Create `packages/remotion/src/components/ProgressBar.tsx`:

```tsx
import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { theme } from "../styles/theme";

interface Section {
  label: string;
  startFrame: number;
  endFrame: number;
}

interface ProgressBarProps {
  sections: Section[];
}

export const ProgressBar: React.FC<ProgressBarProps> = ({ sections }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const overallProgress = frame / durationInFrames;

  // Find current section
  const currentIdx = sections.findIndex(
    (s) => frame >= s.startFrame && frame < s.endFrame
  );

  // Fade in after title, fade out before CTA
  const firstSection = sections[0];
  const lastSection = sections[sections.length - 1];
  if (!firstSection || !lastSection) return null;

  const visibility = interpolate(
    frame,
    [
      firstSection.startFrame,
      firstSection.startFrame + 15,
      lastSection.endFrame - 15,
      lastSection.endFrame,
    ],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  if (visibility <= 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 20,
        left: 40,
        right: 40,
        display: "flex",
        gap: 4,
        opacity: visibility,
      }}
    >
      {sections.map((section, i) => {
        const sectionDuration = section.endFrame - section.startFrame;
        const sectionProgress =
          i < currentIdx
            ? 1
            : i === currentIdx
              ? Math.min(1, (frame - section.startFrame) / sectionDuration)
              : 0;

        return (
          <div
            key={section.label}
            style={{
              flex: 1,
              height: 3,
              backgroundColor: "rgba(255,255,255,0.15)",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${sectionProgress * 100}%`,
                height: "100%",
                backgroundColor: theme.colors.accent,
                borderRadius: 2,
              }}
            />
          </div>
        );
      })}
    </div>
  );
};
```

2. Verify: No build errors in `npx remotion studio`.

3. Commit: `feat(remotion): add ProgressBar overlay component`

---

## Task 4: Integrate ProgressBar into LongFormNews

**Files:**
- Modify: `packages/remotion/src/compositions/LongFormNews/index.tsx`

**Steps:**

1. Import ProgressBar:
```tsx
import { ProgressBar } from "../../components/ProgressBar";
```

2. After building `shotSequences`, build sections array from the shot data:
```tsx
const sections = shotSequences.map(({ shot, from, durationInFrames }) => ({
  label: shot.heading || shot.caption || shot.id,
  startFrame: from,
  endFrame: from + durationInFrames,
}));
```

3. Add ProgressBar to the render output, right before the closing `</AbsoluteFill>` but after Caption:
```tsx
{sections.length > 0 && <ProgressBar sections={sections} />}
```

4. Verify: `npx remotion studio` — thin progress bar appears at top during shot sequences, fades at start/end.

5. Commit: `feat(remotion): integrate ProgressBar into LongFormNews`

---

## Task 5: LowerThird Component

**Files:**
- Create: `packages/remotion/src/components/LowerThird.tsx`

**Steps:**

1. Create `packages/remotion/src/components/LowerThird.tsx`:

```tsx
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { theme } from "../styles/theme";

interface LowerThirdProps {
  source: string;
  showFromFrame?: number;
  showForFrames?: number;
}

export const LowerThird: React.FC<LowerThirdProps> = ({
  source,
  showFromFrame = 30,
  showForFrames = 90,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const relativeFrame = frame - showFromFrame;
  if (relativeFrame < 0 || relativeFrame > showForFrames) return null;

  const slideIn = spring({
    frame: relativeFrame,
    fps,
    config: { damping: 15, mass: 0.6 },
  });

  const fadeOut = interpolate(
    relativeFrame,
    [showForFrames - 15, showForFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <div
      style={{
        position: "absolute",
        bottom: 140,
        left: 40,
        display: "flex",
        alignItems: "center",
        gap: 0,
        transform: `translateX(${(1 - slideIn) * -200}px)`,
        opacity: Math.min(slideIn, fadeOut),
      }}
    >
      <div
        style={{
          width: 4,
          height: 36,
          backgroundColor: theme.colors.accent,
          borderRadius: 2,
        }}
      />
      <div
        style={{
          backgroundColor: "rgba(0,0,0,0.7)",
          padding: "8px 16px",
          borderRadius: "0 6px 6px 0",
        }}
      >
        <span
          style={{
            fontFamily: theme.fonts.body,
            fontSize: theme.fontSizes.small,
            color: theme.colors.textSecondary,
          }}
        >
          {source}
        </span>
      </div>
    </div>
  );
};
```

2. Verify: No build errors.

3. Commit: `feat(remotion): add LowerThird source attribution component`

---

## Task 6: Integrate LowerThird into Screenshot Scene

**Files:**
- Modify: `packages/remotion/src/compositions/LongFormNews/scenes/Screenshot.tsx`
- Modify: `packages/remotion/src/compositions/LongFormNews/schema.ts`

**Steps:**

1. Update `schema.ts` — add optional `source` field to shotSchema:
```ts
// Add to shotSchema, after caption:
source: z.string().optional(),
```

2. Update `Screenshot.tsx` — import and render LowerThird when source is provided:

```tsx
import { LowerThird } from "../../../components/LowerThird";
```

Add `source` to ScreenshotProps interface:
```ts
source?: string;
```

Add to component destructuring and render after caption div:
```tsx
{source && <LowerThird source={source} />}
```

3. Update `renderShot()` in `LongFormNews/index.tsx` to pass source:
```tsx
case "screenshot":
  if (!shot.src) return null;
  return (
    <Screenshot
      src={staticFile(shot.src)}
      caption={shot.caption}
      kenBurns={shot.kenBurns}
      source={shot.source}
    />
  );
```

4. Verify: `npx remotion studio` — screenshot shots with source show attribution overlay.

5. Commit: `feat(remotion): integrate LowerThird into Screenshot scene`

---

## Task 7: BrowserClip Scene

**Files:**
- Create: `packages/remotion/src/compositions/LongFormNews/scenes/BrowserClip.tsx`

**Steps:**

1. Create the BrowserClip scene — renders a Playwright recording inside a styled browser chrome frame:

```tsx
import React from "react";
import { AbsoluteFill, Video } from "remotion";
import { theme } from "../../../styles/theme";

interface BrowserClipProps {
  src: string;
  url?: string;
}

export const BrowserClip: React.FC<BrowserClipProps> = ({ src, url }) => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.bg,
        justifyContent: "center",
        alignItems: "center",
        padding: 40,
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 8px 40px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Browser chrome bar */}
        <div
          style={{
            backgroundColor: "#1e1e2e",
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", gap: 6 }}>
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                backgroundColor: "#ff5f57",
              }}
            />
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                backgroundColor: "#febc2e",
              }}
            />
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                backgroundColor: "#28c840",
              }}
            />
          </div>
          {url && (
            <div
              style={{
                flex: 1,
                backgroundColor: "#2a2a3e",
                borderRadius: 6,
                padding: "6px 12px",
                marginLeft: 8,
              }}
            >
              <span
                style={{
                  fontFamily: theme.fonts.mono,
                  fontSize: 14,
                  color: theme.colors.textMuted,
                }}
              >
                {url}
              </span>
            </div>
          )}
        </div>
        {/* Video content */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          <Video
            src={src}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

2. Update `LongFormNews/index.tsx` — add import and case in `renderShot`:

```tsx
import { BrowserClip } from "./scenes/BrowserClip";

// In renderShot, update browser_recording case:
case "browser_recording":
  if (!shot.src) return null;
  return (
    <BrowserClip
      src={staticFile(shot.src)}
      url={shot.caption}
    />
  );
```

This replaces the previous plain `<Video>` rendering with the styled browser chrome frame.

3. Verify: `npx remotion studio` — browser_recording shots now show inside a browser frame.

4. Commit: `feat(remotion): add BrowserClip scene with browser chrome frame`

---

## Task 8: SplitView Scene

**Files:**
- Create: `packages/remotion/src/compositions/LongFormNews/scenes/SplitView.tsx`
- Modify: `packages/remotion/src/compositions/LongFormNews/schema.ts`
- Modify: `packages/remotion/src/compositions/LongFormNews/index.tsx`

**Steps:**

1. Add `"split_view"` to the shot type enum in `schema.ts`:
```ts
type: z.enum(["screenshot", "text_card", "browser_recording", "split_view"]),
```

Add split-view specific fields:
```ts
leftSrc: z.string().optional(),
rightSrc: z.string().optional(),
leftLabel: z.string().optional(),
rightLabel: z.string().optional(),
```

2. Create `SplitView.tsx`:

```tsx
import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Img,
  spring,
} from "remotion";
import { theme } from "../../../styles/theme";

interface SplitViewProps {
  leftSrc: string;
  rightSrc: string;
  leftLabel?: string;
  rightLabel?: string;
}

export const SplitView: React.FC<SplitViewProps> = ({
  leftSrc,
  rightSrc,
  leftLabel,
  rightLabel,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const slideLeft = spring({
    frame,
    fps,
    config: { damping: 14, mass: 0.8 },
  });
  const slideRight = spring({
    frame: Math.max(0, frame - 5),
    fps,
    config: { damping: 14, mass: 0.8 },
  });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          gap: 4,
          padding: 20,
        }}
      >
        {/* Left panel */}
        <div
          style={{
            flex: 1,
            position: "relative",
            borderRadius: 12,
            overflow: "hidden",
            transform: `translateX(${(1 - slideLeft) * -100}px)`,
            opacity: slideLeft,
          }}
        >
          <Img
            src={leftSrc}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
          {leftLabel && (
            <div
              style={{
                position: "absolute",
                bottom: 16,
                left: 16,
                backgroundColor: "rgba(0,0,0,0.7)",
                padding: "6px 14px",
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  fontFamily: theme.fonts.body,
                  fontSize: theme.fontSizes.small,
                  color: theme.colors.text,
                  fontWeight: 700,
                }}
              >
                {leftLabel}
              </span>
            </div>
          )}
        </div>

        {/* Divider */}
        <div
          style={{
            width: 4,
            backgroundColor: theme.colors.accent,
            borderRadius: 2,
            alignSelf: "stretch",
          }}
        />

        {/* Right panel */}
        <div
          style={{
            flex: 1,
            position: "relative",
            borderRadius: 12,
            overflow: "hidden",
            transform: `translateX(${(1 - slideRight) * 100}px)`,
            opacity: slideRight,
          }}
        >
          <Img
            src={rightSrc}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
          {rightLabel && (
            <div
              style={{
                position: "absolute",
                bottom: 16,
                right: 16,
                backgroundColor: "rgba(0,0,0,0.7)",
                padding: "6px 14px",
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  fontFamily: theme.fonts.body,
                  fontSize: theme.fontSizes.small,
                  color: theme.colors.text,
                  fontWeight: 700,
                }}
              >
                {rightLabel}
              </span>
            </div>
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

3. Update `LongFormNews/index.tsx` — add import and switch case:

```tsx
import { SplitView } from "./scenes/SplitView";

// In renderShot:
case "split_view":
  if (!shot.leftSrc || !shot.rightSrc) return null;
  return (
    <SplitView
      leftSrc={staticFile(shot.leftSrc)}
      rightSrc={staticFile(shot.rightSrc)}
      leftLabel={shot.leftLabel}
      rightLabel={shot.rightLabel}
    />
  );
```

4. Verify: `npx remotion studio` — no build errors.

5. Commit: `feat(remotion): add SplitView scene for side-by-side comparisons`

---

## Task 9: Improved KenBurns with Presets

**Files:**
- Modify: `packages/remotion/src/components/KenBurns.tsx`

**Steps:**

1. Add named preset system to KenBurns. Update the component to accept a `preset` prop that maps to predefined start/end configurations:

```tsx
const PRESETS: Record<string, Omit<KenBurnsProps, "src" | "preset">> = {
  "zoom-in": { startScale: 1.0, endScale: 1.2, startX: 50, startY: 50, endX: 50, endY: 45 },
  "zoom-out": { startScale: 1.2, endScale: 1.0, startX: 50, startY: 45, endX: 50, endY: 50 },
  "pan-left": { startScale: 1.1, endScale: 1.1, startX: 60, startY: 50, endX: 40, endY: 50 },
  "pan-right": { startScale: 1.1, endScale: 1.1, startX: 40, startY: 50, endX: 60, endY: 50 },
  "top-to-bottom": { startScale: 1.1, endScale: 1.1, startX: 50, startY: 30, endX: 50, endY: 70 },
  "bottom-to-top": { startScale: 1.1, endScale: 1.1, startX: 50, startY: 70, endX: 50, endY: 30 },
};
```

Add `preset?: string` to the interface. If `preset` is provided, use its values as defaults (explicit props still override):

```tsx
export const KenBurns: React.FC<KenBurnsProps> = (props) => {
  const presetValues = props.preset ? PRESETS[props.preset] : undefined;
  const {
    src,
    startScale = presetValues?.startScale ?? 1.0,
    endScale = presetValues?.endScale ?? 1.15,
    startX = presetValues?.startX ?? 50,
    startY = presetValues?.startY ?? 50,
    endX = presetValues?.endX ?? 50,
    endY = presetValues?.endY ?? 45,
  } = props;
  // ... rest unchanged
};
```

2. Verify: `npx remotion studio` — existing KenBurns usage unchanged, presets available.

3. Commit: `feat(remotion): add KenBurns presets for common camera movements`

---

## Task 10: ShortForm Composition + Schema

**Files:**
- Create: `packages/remotion/src/compositions/ShortForm/schema.ts`
- Create: `packages/remotion/src/compositions/ShortForm/index.tsx`
- Create: `packages/remotion/src/compositions/ShortForm/scenes/ShortHook.tsx`
- Create: `packages/remotion/src/compositions/ShortForm/scenes/ShortContent.tsx`
- Create: `packages/remotion/src/compositions/ShortForm/scenes/ShortCTA.tsx`
- Create: `packages/remotion/src/components/ShortCaption.tsx`

**Steps:**

1. Create `ShortForm/schema.ts`:

```ts
import { z } from "zod";

const shortCaptionWordSchema = z.object({
  word: z.string(),
  startMs: z.number(),
  endMs: z.number(),
});

const shortShotSchema = z.object({
  id: z.string(),
  type: z.enum(["screenshot", "text_card"]),
  src: z.string().optional(),
  heading: z.string().optional(),
  durationFrames: z.number(),
  kenBurns: z
    .object({
      startScale: z.number().optional(),
      endScale: z.number().optional(),
      startX: z.number().optional(),
      startY: z.number().optional(),
      endX: z.number().optional(),
      endY: z.number().optional(),
      preset: z.string().optional(),
    })
    .optional(),
});

export const shortFormSchema = z.object({
  hookText: z.string(),
  shots: z.array(shortShotSchema),
  audioSrc: z.string().optional(),
  captionWords: z.array(shortCaptionWordSchema).optional(),
  hookDurationFrames: z.number().default(60),
  ctaDurationFrames: z.number().default(60),
});

export type ShortFormProps = z.infer<typeof shortFormSchema>;
export type ShortShotInput = z.infer<typeof shortShotSchema>;
```

2. Create `ShortCaption.tsx` — TikTok-style centered captions with pop animation:

```tsx
import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { theme } from "../styles/theme";
import type { CaptionWord } from "../lib/captions";
import {
  groupCaptions,
  getCurrentCaptionGroup,
  getActiveWordIndex,
} from "../lib/captions";

interface ShortCaptionProps {
  words: CaptionWord[];
  wordsPerGroup?: number;
}

export const ShortCaption: React.FC<ShortCaptionProps> = ({
  words,
  wordsPerGroup = 3,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;

  const groups = groupCaptions(words, wordsPerGroup);
  const activeGroup = getCurrentCaptionGroup(groups, currentMs);

  if (!activeGroup) return null;

  const activeIdx = getActiveWordIndex(activeGroup, currentMs);

  const groupStartFrame = Math.round((activeGroup.startMs / 1000) * fps);
  const relFrame = frame - groupStartFrame;
  const pop = spring({
    frame: Math.max(0, relFrame),
    fps,
    config: { damping: 10, mass: 0.4, stiffness: 200 },
  });

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: 0,
        right: 0,
        transform: `translateY(-50%) scale(${0.8 + pop * 0.2})`,
        display: "flex",
        justifyContent: "center",
        opacity: pop,
      }}
    >
      <div
        style={{
          padding: "12px 24px",
          maxWidth: "85%",
          textAlign: "center",
        }}
      >
        {activeGroup.words.map((w, i) => (
          <span
            key={`${w.startMs}-${i}`}
            style={{
              fontFamily: theme.fonts.heading,
              fontSize: 64,
              fontWeight: 900,
              color: i === activeIdx ? theme.colors.accent : theme.colors.text,
              textShadow: "0 4px 20px rgba(0,0,0,0.9), 0 2px 4px rgba(0,0,0,0.8)",
              textTransform: "uppercase",
              letterSpacing: -1,
            }}
          >
            {w.word}{" "}
          </span>
        ))}
      </div>
    </div>
  );
};
```

3. Create `ShortHook.tsx`:

```tsx
import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
} from "remotion";
import { theme } from "../../../styles/theme";

interface ShortHookProps {
  text: string;
}

export const ShortHook: React.FC<ShortHookProps> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({
    frame,
    fps,
    config: { damping: 8, mass: 0.5, stiffness: 180 },
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.bg,
        justifyContent: "center",
        alignItems: "center",
        padding: 40,
      }}
    >
      <h1
        style={{
          fontFamily: theme.fonts.heading,
          fontSize: 80,
          fontWeight: 900,
          color: theme.colors.text,
          textAlign: "center",
          lineHeight: 1.1,
          transform: `scale(${scale})`,
          opacity: scale,
          textShadow: `0 0 40px ${theme.colors.accentGlow}`,
        }}
      >
        {text}
      </h1>
    </AbsoluteFill>
  );
};
```

4. Create `ShortContent.tsx`:

```tsx
import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { KenBurns } from "../../../components/KenBurns";
import { theme } from "../../../styles/theme";

interface ShortContentProps {
  type: "screenshot" | "text_card";
  src?: string;
  heading?: string;
  kenBurns?: {
    startScale?: number;
    endScale?: number;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    preset?: string;
  };
}

export const ShortContent: React.FC<ShortContentProps> = ({
  type,
  src,
  heading,
  kenBurns,
}) => {
  if (type === "screenshot" && src) {
    return (
      <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
        <KenBurns src={src} {...kenBurns} />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.bg,
        justifyContent: "center",
        alignItems: "center",
        padding: 40,
      }}
    >
      <h2
        style={{
          fontFamily: theme.fonts.heading,
          fontSize: 56,
          fontWeight: 800,
          color: theme.colors.text,
          textAlign: "center",
          lineHeight: 1.2,
        }}
      >
        {heading}
      </h2>
    </AbsoluteFill>
  );
};
```

5. Create `ShortCTA.tsx`:

```tsx
import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { theme } from "../../../styles/theme";

export const ShortCTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const bounce = spring({
    frame,
    fps,
    config: { damping: 10, mass: 0.5 },
  });

  const pulse = interpolate(
    Math.sin(frame * 0.2),
    [-1, 1],
    [0.95, 1.05]
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          textAlign: "center",
          transform: `scale(${bounce})`,
          opacity: bounce,
        }}
      >
        <div
          style={{
            fontSize: 80,
            marginBottom: 20,
          }}
        >
          👆
        </div>
        <h2
          style={{
            fontFamily: theme.fonts.heading,
            fontSize: 52,
            fontWeight: 900,
            color: theme.colors.text,
            margin: 0,
          }}
        >
          Follow for more
        </h2>
        <div
          style={{
            marginTop: 24,
            backgroundColor: theme.colors.accent,
            padding: "14px 48px",
            borderRadius: 50,
            transform: `scale(${pulse})`,
            display: "inline-block",
          }}
        >
          <span
            style={{
              fontFamily: theme.fonts.heading,
              fontSize: 28,
              fontWeight: 700,
              color: "#ffffff",
            }}
          >
            SUBSCRIBE
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
```

6. Create `ShortForm/index.tsx`:

```tsx
import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { ShortFormProps, ShortShotInput } from "./schema";
import { ShortHook } from "./scenes/ShortHook";
import { ShortContent } from "./scenes/ShortContent";
import { ShortCTA } from "./scenes/ShortCTA";
import { ShortCaption } from "../../components/ShortCaption";
import { Fade } from "../../components/Fade";
import { theme } from "../../styles/theme";

function renderShortShot(shot: ShortShotInput) {
  if (shot.type === "screenshot" && shot.src) {
    return (
      <ShortContent
        type="screenshot"
        src={staticFile(shot.src)}
        kenBurns={shot.kenBurns}
      />
    );
  }
  return <ShortContent type="text_card" heading={shot.heading || ""} />;
}

export const ShortForm: React.FC<ShortFormProps> = ({
  hookText,
  shots,
  audioSrc,
  captionWords,
  hookDurationFrames = 60,
  ctaDurationFrames = 60,
}) => {
  let currentFrame = 0;

  const hookStart = currentFrame;
  currentFrame += hookDurationFrames;

  const shotSequences = shots.map((shot) => {
    const start = currentFrame;
    currentFrame += shot.durationFrames;
    return { shot, from: start, durationInFrames: shot.durationFrames };
  });

  const ctaStart = currentFrame;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
      {audioSrc && <Audio src={staticFile(audioSrc)} />}

      <Sequence from={hookStart} durationInFrames={hookDurationFrames}>
        <Fade>
          <ShortHook text={hookText} />
        </Fade>
      </Sequence>

      {shotSequences.map(({ shot, from, durationInFrames }) => (
        <Sequence key={shot.id} from={from} durationInFrames={durationInFrames}>
          <Fade>
            {renderShortShot(shot)}
          </Fade>
        </Sequence>
      ))}

      <Sequence from={ctaStart} durationInFrames={ctaDurationFrames}>
        <Fade enterDurationFrames={10} exitDurationFrames={0}>
          <ShortCTA />
        </Fade>
      </Sequence>

      {captionWords && captionWords.length > 0 && (
        <ShortCaption words={captionWords} />
      )}
    </AbsoluteFill>
  );
};
```

7. Verify: No build errors.

8. Commit: `feat(remotion): add ShortForm composition (9:16, 60s) with TikTok-style captions`

---

## Task 11: Register ShortForm in Root.tsx

**Files:**
- Modify: `packages/remotion/src/Root.tsx`

**Steps:**

1. Add imports:
```tsx
import { ShortForm } from "./compositions/ShortForm/index";
import { shortFormSchema } from "./compositions/ShortForm/schema";
```

2. Add default props:
```tsx
const defaultShortFormProps = {
  hookText: "OpenAI just dropped GPT-5",
  shots: [
    {
      id: "short-1",
      type: "text_card" as const,
      heading: "3x faster, half the cost",
      durationFrames: 90,
    },
    {
      id: "short-2",
      type: "text_card" as const,
      heading: "Native multimodal reasoning",
      durationFrames: 90,
    },
  ],
  hookDurationFrames: 60,
  ctaDurationFrames: 60,
};
```

3. Add Composition registration after Thumbnail:
```tsx
<Composition
  id="ShortForm"
  component={ShortForm}
  durationInFrames={
    defaultShortFormProps.hookDurationFrames +
    defaultShortFormProps.shots.reduce((sum, s) => sum + s.durationFrames, 0) +
    defaultShortFormProps.ctaDurationFrames
  }
  fps={30}
  width={1080}
  height={1920}
  schema={shortFormSchema}
  defaultProps={defaultShortFormProps}
  calculateMetadata={async ({ props }) => {
    const totalFrames =
      (props.hookDurationFrames ?? 60) +
      props.shots.reduce((sum: number, s: { durationFrames: number }) => sum + s.durationFrames, 0) +
      (props.ctaDurationFrames ?? 60);
    return { durationInFrames: totalFrames };
  }}
/>
```

4. Verify: `npx remotion studio` — ShortForm composition appears in sidebar, renders at 1080×1920.

5. Commit: `feat(remotion): register ShortForm composition in Root`

---

## Task 12: Thumbnail Style Variants

**Files:**
- Create: `packages/remotion/src/compositions/Thumbnail/variants/BoldThumbnail.tsx`
- Create: `packages/remotion/src/compositions/Thumbnail/variants/MinimalThumbnail.tsx`
- Create: `packages/remotion/src/compositions/Thumbnail/variants/ComparisonThumbnail.tsx`
- Modify: `packages/remotion/src/compositions/Thumbnail/schema.ts`
- Modify: `packages/remotion/src/compositions/Thumbnail/index.tsx`

**Steps:**

1. Update `schema.ts` to add variant support:

```ts
import { z } from "zod";

export const thumbnailSchema = z.object({
  title: z.string(),
  backgroundSrc: z.string().optional(),
  accentColor: z.string().default("#6366f1"),
  variant: z.enum(["default", "bold", "minimal", "comparison"]).default("default"),
  // comparison-specific
  leftLabel: z.string().optional(),
  rightLabel: z.string().optional(),
  leftSrc: z.string().optional(),
  rightSrc: z.string().optional(),
});

export type ThumbnailProps = z.infer<typeof thumbnailSchema>;
```

2. Create `BoldThumbnail.tsx` — large text with gradient background, no image:

```tsx
import React from "react";
import { AbsoluteFill } from "remotion";
import { theme } from "../../../styles/theme";

interface BoldThumbnailProps {
  title: string;
  accentColor: string;
}

export const BoldThumbnail: React.FC<BoldThumbnailProps> = ({
  title,
  accentColor,
}) => {
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${theme.colors.bg} 0%, #1a1a2e 50%, ${accentColor}33 100%)`,
        justifyContent: "center",
        alignItems: "center",
        padding: "48px 64px",
      }}
    >
      <h1
        style={{
          fontFamily: theme.fonts.heading,
          fontSize: 80,
          fontWeight: 900,
          color: theme.colors.text,
          lineHeight: 1.1,
          textAlign: "center",
          textShadow: `0 0 60px ${accentColor}66`,
        }}
      >
        {title}
      </h1>
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 6,
          backgroundColor: accentColor,
        }}
      />
    </AbsoluteFill>
  );
};
```

3. Create `MinimalThumbnail.tsx` — clean, understated:

```tsx
import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { theme } from "../../../styles/theme";

interface MinimalThumbnailProps {
  title: string;
  backgroundSrc?: string;
  accentColor: string;
}

export const MinimalThumbnail: React.FC<MinimalThumbnailProps> = ({
  title,
  backgroundSrc,
  accentColor,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
      {backgroundSrc && (
        <Img
          src={backgroundSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: 0.15,
          }}
        />
      )}
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          padding: "48px 64px",
        }}
      >
        <div
          style={{
            borderLeft: `4px solid ${accentColor}`,
            paddingLeft: 24,
          }}
        >
          <h1
            style={{
              fontFamily: theme.fonts.heading,
              fontSize: 56,
              fontWeight: 700,
              color: theme.colors.text,
              lineHeight: 1.2,
              margin: 0,
            }}
          >
            {title}
          </h1>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
```

4. Create `ComparisonThumbnail.tsx` — side-by-side with VS divider:

```tsx
import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { theme } from "../../../styles/theme";

interface ComparisonThumbnailProps {
  title: string;
  leftSrc?: string;
  rightSrc?: string;
  leftLabel?: string;
  rightLabel?: string;
  accentColor: string;
}

export const ComparisonThumbnail: React.FC<ComparisonThumbnailProps> = ({
  title,
  leftSrc,
  rightSrc,
  leftLabel,
  rightLabel,
  accentColor,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
      <div style={{ display: "flex", width: "100%", height: "100%" }}>
        {/* Left half */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {leftSrc && (
            <Img
              src={leftSrc}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: 0.6,
              }}
            />
          )}
          {leftLabel && (
            <div
              style={{
                position: "absolute",
                bottom: 80,
                left: 20,
                backgroundColor: "rgba(0,0,0,0.7)",
                padding: "8px 16px",
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  fontFamily: theme.fonts.heading,
                  fontSize: 28,
                  fontWeight: 700,
                  color: theme.colors.text,
                }}
              >
                {leftLabel}
              </span>
            </div>
          )}
        </div>

        {/* VS divider */}
        <div
          style={{
            width: 60,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: accentColor,
            zIndex: 1,
          }}
        >
          <span
            style={{
              fontFamily: theme.fonts.heading,
              fontSize: 28,
              fontWeight: 900,
              color: "#ffffff",
              transform: "rotate(-90deg)",
            }}
          >
            VS
          </span>
        </div>

        {/* Right half */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {rightSrc && (
            <Img
              src={rightSrc}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: 0.6,
              }}
            />
          )}
          {rightLabel && (
            <div
              style={{
                position: "absolute",
                bottom: 80,
                right: 20,
                backgroundColor: "rgba(0,0,0,0.7)",
                padding: "8px 16px",
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  fontFamily: theme.fonts.heading,
                  fontSize: 28,
                  fontWeight: 700,
                  color: theme.colors.text,
                }}
              >
                {rightLabel}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Title overlay */}
      <div
        style={{
          position: "absolute",
          top: 24,
          left: 0,
          right: 0,
          textAlign: "center",
        }}
      >
        <h1
          style={{
            fontFamily: theme.fonts.heading,
            fontSize: 48,
            fontWeight: 900,
            color: theme.colors.text,
            textShadow: "0 2px 20px rgba(0,0,0,0.9)",
          }}
        >
          {title}
        </h1>
      </div>
    </AbsoluteFill>
  );
};
```

5. Update `Thumbnail/index.tsx` to route by variant:

```tsx
import React from "react";
import { AbsoluteFill, Img } from "remotion";
import type { ThumbnailProps } from "./schema";
import { theme } from "../../styles/theme";
import { BoldThumbnail } from "./variants/BoldThumbnail";
import { MinimalThumbnail } from "./variants/MinimalThumbnail";
import { ComparisonThumbnail } from "./variants/ComparisonThumbnail";

export const Thumbnail: React.FC<ThumbnailProps> = (props) => {
  const {
    title,
    backgroundSrc,
    accentColor = theme.colors.accent,
    variant = "default",
  } = props;

  switch (variant) {
    case "bold":
      return <BoldThumbnail title={title} accentColor={accentColor} />;
    case "minimal":
      return (
        <MinimalThumbnail
          title={title}
          backgroundSrc={backgroundSrc}
          accentColor={accentColor}
        />
      );
    case "comparison":
      return (
        <ComparisonThumbnail
          title={title}
          leftSrc={props.leftSrc}
          rightSrc={props.rightSrc}
          leftLabel={props.leftLabel}
          rightLabel={props.rightLabel}
          accentColor={accentColor}
        />
      );
    case "default":
    default:
      return (
        <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
          {backgroundSrc && (
            <Img
              src={backgroundSrc}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: 0.3,
                filter: "blur(2px)",
              }}
            />
          )}
          <AbsoluteFill
            style={{
              background: `linear-gradient(135deg, rgba(0,0,0,0.8) 0%, transparent 60%)`,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 8,
              backgroundColor: accentColor,
            }}
          />
          <AbsoluteFill
            style={{
              justifyContent: "center",
              padding: "48px 64px",
            }}
          >
            <h1
              style={{
                fontFamily: theme.fonts.heading,
                fontSize: theme.fontSizes.thumbnailTitle,
                fontWeight: 900,
                color: theme.colors.text,
                lineHeight: 1.15,
                margin: 0,
                textShadow: "0 2px 20px rgba(0,0,0,0.8)",
                maxWidth: "90%",
              }}
            >
              {title}
            </h1>
          </AbsoluteFill>
        </AbsoluteFill>
      );
  }
};
```

6. Verify: `npx remotion studio` — Thumbnail still renders. Schema now accepts variant.

7. Commit: `feat(remotion): add Bold, Minimal, and Comparison thumbnail variants`

---

## Task 13: Update render.ts for New Features

**Files:**
- Modify: `packages/pipeline/src/render.ts`
- Modify: `packages/shared/src/types/visual-plan.ts`

**Steps:**

1. Update `ShotPlan` type in `visual-plan.ts` to include new fields:

```ts
export interface ShotPlan {
  id: string;
  sectionId: string;
  type: "screenshot" | "browser_recording" | "text_card" | "split_view";
  url?: string;
  selector?: string;
  scrollTo?: string;
  clickSequence?: string[];
  durationMs: number;
  caption?: string;
  source?: string;
  textContent?: string;
  transition?: "none" | "fade" | "wipe-left" | "wipe-right" | "wipe-up" | "wipe-down";
  kenBurns?: {
    startScale: number;
    endScale: number;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    preset?: string;
  };
  // split_view specific
  leftAssetId?: string;
  rightAssetId?: string;
  leftLabel?: string;
  rightLabel?: string;
}
```

2. Update `render.ts` — map new fields through to Remotion props:

In the `remotionShots` mapping, add the new fields:

```ts
return {
  id: shot.id,
  type: shot.type,
  src,
  caption: shot.caption,
  source: shot.source,
  heading: shot.type === "text_card" ? shot.textContent || shot.caption : undefined,
  body: undefined as string | undefined,
  durationFrames: msToFrames(shot.durationMs, fps),
  kenBurns: shot.kenBurns,
  transition: shot.transition ?? "fade",
  leftSrc: shot.leftAssetId ? toRelativeSrc(jobAssets.find(a => a.shotId === shot.leftAssetId)?.filePath || "") : undefined,
  rightSrc: shot.rightAssetId ? toRelativeSrc(jobAssets.find(a => a.shotId === shot.rightAssetId)?.filePath || "") : undefined,
  leftLabel: shot.leftLabel,
  rightLabel: shot.rightLabel,
};
```

3. Verify: `npx tsx packages/pipeline/src/render.ts --job 1` still works (or at least compiles without errors if no job exists).

4. Commit: `feat(pipeline): update render.ts and ShotPlan type for Sprint 2 features`

---

## Task 14: Remotion Studio Verification + Benchmark

**Steps:**

1. Run `npx remotion studio` from the `packages/remotion` directory.

2. Verify all three compositions appear:
   - LongFormNews (1920×1080, 30fps)
   - ShortForm (1080×1920, 30fps)
   - Thumbnail (1280×720, Still)

3. Preview each composition — confirm no rendering errors.

4. Benchmark: Run a test render from the command line to measure render time:

```bash
cd "C:/LTX Automation"
time npx remotion render packages/remotion/src/index.ts LongFormNews data/benchmark-longform.mp4 --codec h264
```

Record the render time. Then:

```bash
time npx remotion render packages/remotion/src/index.ts ShortForm data/benchmark-shortform.mp4 --codec h264
```

5. Clean up benchmark files.

6. Commit: `chore: Sprint 2 complete — Remotion polish + ShortForm + Thumbnail variants`

---

## Verification

After all tasks, verify:
1. `npx remotion studio` shows 3 compositions without errors
2. LongFormNews shots fade between each other
3. ProgressBar appears during content shots, not during title/CTA
4. LowerThird shows on screenshot shots with source attribution
5. BrowserClip renders browser_recording shots in chrome frame
6. ShortForm renders at 1080×1920 with TikTok-style centered captions
7. Thumbnail renders all 4 variants (default, bold, minimal, comparison)
8. `render.ts` compiles with new ShotPlan fields
9. Benchmark render times recorded for reference
