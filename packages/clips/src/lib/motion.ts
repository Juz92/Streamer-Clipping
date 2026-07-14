/**
 * motion.ts — pan/zoom motion planning for rendered clips.
 *
 * Two effects, both expressed as a single ffmpeg `zoompan` z-expression:
 *
 *   1. Ken Burns creep — a slow uniform zoom over the whole clip (talking
 *      mode only; it looks wrong on the 2-panel gameplay layout).
 *   2. Punch-ins — brief 1.00 → PEAK → 1.00 kicks at specific moments:
 *         a. The flash→content seam (always)
 *         b. Whisper word hits matching PUNCH_KEYWORDS inside the content
 *
 * OpusClip-style punches use ease-out cubic so the kick is instant and the
 * decay is smooth. We render that as `PEAK * (1 - (t-p)/D)^3` held inside a
 * `between(...)` gate.
 *
 * All outputs are pure strings — the caller stitches them into zoompan.
 * No ffmpeg calls from here, no file I/O, no side effects.
 */

import type { WhisperWord } from "./whisper-captions.js";

export type LayoutMode = "gameplay" | "talking";

export interface PunchEvent {
  /** Clip-relative seconds where the peak hits. */
  atSec: number;
  /** Ease-back duration in seconds (ffmpeg time after the peak). */
  durationSec: number;
  /** Extra zoom factor at the peak (0.10 means 1.10×). */
  peak: number;
  /** Debug label shown in logs / trim-results. */
  label: string;
}

export interface MotionPlan {
  kenBurnsRange: number;
  events: PunchEvent[];
}

/**
 * Curated keyword list for motion triggers. Kept SHORTER than the scoring
 * keywords — punch-ins are attention hits and we don't want one every five
 * seconds. These are the words where zooming onto the speaker actually pays
 * off because the next beat is visually small (a reaction face) or verbally
 * hot (the exclamation itself).
 */
const PUNCH_KEYWORDS: string[] = [
  "no way",
  "oh my god",
  "holy",
  "what the",
  "clip that",
  "insane",
  "lock in",
  "hooray",
  "bruh",
  "dude",
];

const PUNCH_PEAK_DEFAULT = 0.1; // 1.10× zoom
const PUNCH_FALL_DEFAULT = 0.5; // 0.5s ease-back
const SEAM_PEAK = 0.08;
const SEAM_FALL = 0.4;
const KEN_BURNS_TALKING = 0.04;
const MIN_PUNCH_GAP_SEC = 3.5;
const DEFAULT_FPS = 30;

function matchesKeyword(phrase: string, words: WhisperWord[], fromIdx: number): number {
  const phraseTokens = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (phraseTokens.length === 0) return 0;
  for (let j = 0; j < phraseTokens.length; j++) {
    const w = words[fromIdx + j];
    if (!w) return 0;
    const clean = w.word.toLowerCase().replace(/[^\w]/g, "");
    if (clean !== phraseTokens[j]) return 0;
  }
  return phraseTokens.length;
}

/**
 * Find every keyword hit in the finalized-clip whisper words and build a
 * PunchEvent list. Deduplicates events that land within MIN_PUNCH_GAP_SEC
 * of each other to avoid visual strobing.
 */
export function findKeywordPunches(words: WhisperWord[], flashDurSec: number): PunchEvent[] {
  const raw: PunchEvent[] = [];

  for (let i = 0; i < words.length; i++) {
    for (const kw of PUNCH_KEYWORDS) {
      const matched = matchesKeyword(kw, words, i);
      if (matched > 0) {
        const hitSec = words[i].startMs / 1000;
        // Don't place keyword punches on top of the seam punch — the seam
        // already owns the 0-2s window, and anything before flashDur would
        // fire during the flash itself.
        if (hitSec > flashDurSec + 0.5) {
          raw.push({
            atSec: hitSec,
            durationSec: PUNCH_FALL_DEFAULT,
            peak: PUNCH_PEAK_DEFAULT,
            label: `kw:${kw.replace(/\s+/g, "_")}`,
          });
        }
        break; // only one keyword match per starting position
      }
    }
  }

  // Collapse near-duplicates. Keep the earliest; drop anything within
  // MIN_PUNCH_GAP_SEC of an already-kept event.
  raw.sort((a, b) => a.atSec - b.atSec);
  const kept: PunchEvent[] = [];
  for (const e of raw) {
    const last = kept[kept.length - 1];
    if (!last || e.atSec - last.atSec >= MIN_PUNCH_GAP_SEC) kept.push(e);
  }
  return kept;
}

/**
 * Build the zoompan z-expression for the whole clip.
 *
 * Output value is the zoom factor at output frame time `on / fps`:
 *   z = 1 + kenBurnsOffset + punch1Offset + punch2Offset + ...
 *
 * Each punch uses an ease-out cubic: the zoom peaks instantly at `atSec` and
 * decays to zero over `durationSec`. Punches are gap-deduped, so flat
 * addition avoids ffmpeg zoompan parser crashes from comma-based max()/pow().
 */
export function buildZoomExpr(
  events: PunchEvent[],
  totalDurSec: number,
  kenBurnsRange: number,
): string {
  const parts: string[] = [];

  if (kenBurnsRange > 0 && totalDurSec > 0) {
    parts.push(`(${kenBurnsRange}*(on/${DEFAULT_FPS})/${totalDurSec.toFixed(3)})`);
  }

  for (const e of events) {
    const start = e.atSec.toFixed(3);
    const end = (e.atSec + e.durationSec).toFixed(3);
    const dur = e.durationSec.toFixed(3);
    const peak = e.peak.toFixed(3);
    const t = `(on/${DEFAULT_FPS})`;
    // Gate: active only between start and start+duration. Commas must be
    // escaped because this expression is embedded inside an ffmpeg filter
    // chain/script where raw commas split filters/options.
    const gate = `between(${t}\\,${start}\\,${end})`;
    // Ease-out cubic: peak at start, decays to zero over duration.
    // Use explicit multiplication instead of ^ or pow(), because zoompan's
    // expression parser rejects ^ and comma escaping makes pow() fragile.
    const decay = `(1-(${t}-${start})/${dur})`;
    const eased = `${gate}*${peak}*${decay}*${decay}*${decay}`;
    parts.push(eased);
  }

  if (parts.length === 0) return "1";

  // Flat addition — no commas, no nested max() calls.
  // zoompan uses : as parameter separator, so commas in expressions crash.
  // Punches don't overlap (MIN_PUNCH_GAP_SEC), so addition is safe.
  return `1+${parts.join("+")}`;
}

/**
 * Produce the complete motion plan for a clip. Caller decides whether to
 * apply it to the filter graph (empty plan => no zoompan needed).
 */
export function planMotion(
  contentWords: WhisperWord[] | null,
  flashDurSec: number,
  totalDurSec: number,
  mode: LayoutMode,
): MotionPlan {
  const events: PunchEvent[] = [];

  if (flashDurSec > 0 && flashDurSec < totalDurSec - 0.5) {
    events.push({
      atSec: flashDurSec,
      durationSec: SEAM_FALL,
      peak: SEAM_PEAK,
      label: "seam",
    });
  }

  if (contentWords && contentWords.length > 0) {
    events.push(...findKeywordPunches(contentWords, flashDurSec));
  }

  // Ken Burns is only tasteful on single-viewport talking clips. On the
  // 2-panel gameplay layout it scales the avatar and gameplay panels
  // differently relative to the divider line, which looks sloppy.
  const kenBurnsRange = mode === "talking" ? KEN_BURNS_TALKING : 0;

  return { kenBurnsRange, events };
}

/**
 * Build the full zoompan filter string (`zoompan=...`) ready to drop into
 * a filter_complex chain. Returns null when the plan produces no motion —
 * caller should skip the filter entirely in that case to avoid a pointless
 * re-encode pass through zoompan.
 */
export function buildZoompanFilter(
  plan: MotionPlan,
  totalDurSec: number,
  outputW = 1080,
  outputH = 1920,
  fps = 30,
): string | null {
  // FIXED: Expression now uses flat addition instead of nested max() calls,
  // avoiding commas that crash ffmpeg's zoompan parser.
  if (plan.events.length === 0 && plan.kenBurnsRange === 0) return null;
  const z = buildZoomExpr(plan.events, totalDurSec, plan.kenBurnsRange);
  return (
    `fps=${fps},zoompan=z='${z}':d=1:` +
    `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `s=${outputW}x${outputH}:fps=${fps}`
  );
}
