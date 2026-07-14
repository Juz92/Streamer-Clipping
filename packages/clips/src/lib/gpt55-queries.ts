/**
 * gpt55-queries.ts — Unified prompts for GPT-5.5 transcript analysis.
 *
 * Combines all 7 NotebookLM query lenses into 2 efficient prompts:
 *   1. UNIFIED_ANALYSIS — All categories in one shot (humor, running bits,
 *      emotional peaks, roasts, crash-outs, one-liners, story-of-stream)
 *   2. UNIFIED_ENRICHMENT — Timestamps + rubric scoring for top candidates
 *
 * GPT-5.5's 256K context window easily fits a full stream transcript + these
 * prompts, eliminating NotebookLM's upload/query overhead.
 */

export const UNIFIED_SYSTEM_PROMPT = `You are an expert gaming content analyst reviewing transcripts from "The Burnt Peanut" for high-recall YouTube Shorts discovery. Find complete candidate arcs; a later video pass verifies visuals and trims the final edit.

EDITORIAL PRIORITY:
1. Peanut Bits — character riffs, stories, roasts, creator/meta commentary, quotable personality.
2. Squad Chaos — escalating social conflict, betrayal, blame, panic, callbacks.
3. WTF Game Moments — genuinely strange or surprising events with a clear reaction.
4. Peanut Plays — obvious clutch, multi-kill, comeback or skill payoff.
5. The Mission — objective, progress/setback and satisfying result in one understandable arc.

CRITICAL RULES:
- DISCOVERY WINDOW: Candidate arcs may be 20-100 seconds. Do not reject a strong bit because the final editor must shorten it.
- PREMISE: The premise should become understandable within roughly 5 seconds. A later flash may be used as a cold open.
- PERSONALITY FIRST: A strong story, roast or character bit can beat loud gameplay. Generic shouting and tactical repetition are not personality.
- BROAD APPEAL: Prioritize moments understandable without knowing the game.
- PAYOFF: Require a laugh, roast, wow, WTF, tension or satisfaction payoff. Do not force non-comedy into an LOL score.
- TRANSCRIPT LIMIT: Do not claim face visibility or visual quality from transcript evidence. Flag likely visual moments for later verification.
- CLEAN END: Capture the complete setup/escalation/payoff and end after the payoff line, never mid-sentence.
- NO FILLER: Return fewer picks when the chunk lacks strong material. Do not pad category quotas.

Output ONLY the requested structured data. No meta-text, no explanations, no "Here are the picks..."`;

function parseHms(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return -1;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function formatHms(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function windowTimestampedTranscript(
  transcript: string,
  windowSec = 180,
  strideSec = 60,
): string[] {
  if (windowSec <= 0 || strideSec <= 0) throw new RangeError("windowSec and strideSec must be positive");

  const entries = transcript
    .split(/\r?\n/)
    .map((line) => ({ line, sec: parseHms(line.match(/^\[(\d{2}:\d{2}:\d{2})\]/)?.[1] ?? "") }))
    .filter((entry) => entry.line && entry.sec >= 0);
  if (entries.length === 0) return [];

  const windows: string[] = [];
  const lastSec = entries[entries.length - 1].sec;
  // ponytail: O(cues × windows) is ~5M checks for a 7.5h VOD; index it only if this becomes measurable.
  for (let startSec = 0; startSec <= lastSec; startSec += strideSec) {
    const lines = entries
      .filter((entry) => entry.sec >= startSec && entry.sec < startSec + windowSec)
      .map((entry) => entry.line);
    if (lines.length === 0) continue;
    windows.push(`WINDOW [${formatHms(startSec)}]-[${formatHms(startSec + windowSec)}]\n${lines.join("\n")}`);
  }
  return windows;
}

export const TRANSCRIPT_RECALL_ANALYSIS = (transcript: string): string => `Review every labeled transcript window independently. Do not compare windows or spend a quota across the batch.

Return one JSON object with exactly this shape:
{
  "windows": [
    {
      "windowStart": "HH:MM:SS",
      "candidate": null
    },
    {
      "windowStart": "HH:MM:SS",
      "candidate": {
        "start": "HH:MM:SS",
        "end": "HH:MM:SS",
        "lane": "Peanut Bits",
        "strength": 5,
        "title": "Short title",
        "reason": "Why the complete arc pays off",
        "quote": "Best exact quote"
      }
    }
  ]
}

Include exactly one windows entry per labeled input window. Use candidate null when no strong complete arc exists; otherwise return only that window's strongest 20-140 second arc.

Prefer creator/meta riffs, roasts, absurd monologues, recurring bits, and phrase loops only when meaning escalates. Reject generic yelling, tactical repetition, isolated combat, and energy without a story.

Lane must be exactly one of: Peanut Bits, Squad Chaos, WTF Game Moments, Peanut Plays, The Mission. Strength is 3 (possible), 4 (strong), or 5 (exceptional). Transcript-only WTF/Play/Mission picks are nominations for later visual verification.

Use exact transcript timestamps and complete boundaries. Return JSON only.

WINDOWS:
${transcript}`;

export const UNIFIED_ANALYSIS = (transcript: string): string =>
  `Analyze this gaming stream transcript across ALL categories. Return picks for each category in the exact format specified.

TRANSCRIPT:
---
${transcript.slice(0, 120_000)}
---

${transcript.length > 120_000 ? "\n[Transcript truncated for length — analyze what's provided]\n" : ""}

## CATEGORY 1: HUMOR (Top 10)
Identify the funniest moments: jokes, reactions, callbacks, absurd moments, dry delivery, setup-payoff pairs.
Format per pick:
N. **Short Title**
    *   **Timestamp:** [HH:MM:SS] (start of MAIN CONTENT)
    *   **Flash Timestamp:** [HH:MM:SS] or "none"
    *   **Hook:** One sentence for YouTube Short title
    *   **Quote:** "Direct quote"
    *   **Why it's funny:** 1-2 sentences, including why it passes the genuine LOL test
    *   **Funny Quote:** Yes or No — only if the quote is funny out of context
    *   **LOL Potential:** 0-5, where 5 means try-not-to-laugh/wet-yourself
    *   **Setup Needed:** Yes or No
    *   **Humor Type:** callback / running-bit / dry-joke / absurdist / reaction-gold / character-moment
    *   **Broad Appeal:** Yes or No
    *   **Visual Type:** gameplay or talking

## CATEGORY 2: RUNNING BITS (Top 8)
Identify recurring jokes, inside references, themes that appear multiple times. For each:
### N. Bit Name
*   **Timestamps:** [HH:MM:SS], [HH:MM:SS]...
*   **Description:** One sentence
*   **Best Single Clip:** [HH:MM:SS] — why this standalone moment works
*   **Visual Type:** gameplay or talking

## CATEGORY 3: EMOTIONAL PEAKS (Top 8)
Rage, wholesome, shock, triumph, cringe, fear, resignation, explosive joy. Quiet peaks the keyword scorer misses.
Format per pick:
N. **Short Title — Emotion Type**
    *   **Timestamp:** [HH:MM:SS]
    *   **Flash Timestamp:** [HH:MM:SS] or "none"
    *   **Hook:** One sentence
    *   **Emotion:** rage / wholesome / triumph / shock / cringe / resignation / explosive-joy
    *   **Setup Needed:** Yes or No
    *   **Visual Type:** gameplay or talking

## CATEGORY 4: FRIEND ROASTS (Top 8)
Back-and-forth roast chains that escalate. Callouts, pile-ons, devastating comebacks. The key is ESCALATION.
Format per pick:
N. **Short Title**
    *   **Timestamp:** [HH:MM:SS] (start of the CHAIN, not just punchline)
    *   **Flash Timestamp:** [HH:MM:SS] or "none"
    *   **Hook:** One sentence capturing the roast arc
    *   **Quote:** Best line from the exchange
    *   **Parties:** Who is roasting who
    *   **Setup Needed:** Yes or No
    *   **Visual Type:** gameplay or talking

## CATEGORY 5: CRASH-OUTS (Top 8)
Tilt spirals: escalating frustration, rage quit threats, absurd blame deflection, meltdowns + friends roasting the tilt.
Format per pick:
N. **Short Title**
    *   **Timestamp:** [HH:MM:SS] (START of escalation)
    *   **Flash Timestamp:** [HH:MM:SS] or "none"
    *   **Hook:** One sentence describing the crash-out arc
    *   **Crash Type:** rage-spiral / blame-deflection / rage-quit-threat / tilt-plus-roast / meltdown
    *   **Setup Needed:** Yes or No
    *   **Visual Type:** gameplay or talking

## CATEGORY 6: ONE-LINERS (Top 12)
Standalone zingers, punchlines, metaphors, unexpected phrasings (5-15 words). Thumbnail/title fodder.
Format per pick:
N. **"Exact quote"**
    *   **Timestamp:** [HH:MM:SS]
    *   **Context:** One sentence
    *   **Why quotable:** Meme potential
    *   **Broad Appeal:** Yes or No
    *   **Visual Type:** gameplay or talking

## CATEGORY 7: STORY OF STREAM (1 pick)
THE single moment that defines this stream. The one viewers would tell friends about.
Format:
### The Story of the Stream
**Timestamp:** [HH:MM:SS]
**Flash Timestamp:** [HH:MM:SS] or "none"
**Hook:** One-sentence hook
**Visual Type:** gameplay or talking
**Why THE moment:** 2-3 sentences

IMPORTANT: Output ALL categories. Use the exact formatting. No meta-text.`;

export interface EnrichmentCandidate {
  id: number;
  timestamp: string;
  hook: string;
}

export const UNIFIED_ENRICHMENT_TIMESTAMPS = (candidates: EnrichmentCandidate[]): string => {
  const list = candidates.map((c) => `${c.id}. [${c.timestamp}] — ${c.hook}`).join("\n");

  return `For each candidate below, provide precise timestamps that drive clip rendering.

Candidates:
${list}

For each, provide EXACTLY:

**N. [HH:MM:SS] — Short label**
- Cold open: [HH:MM:SS] (where clip STARTS — 2-5s before main moment for setup/reaction; if first 3s of main moment are already strong, use main timestamp)
- Flash timestamp: [HH:MM:SS] or "none" (stronger scroll-stopping moment within first 4-8s to show as cold open; "none" if not needed)
- Natural end: [HH:MM:SS] (clean audio exit, never mid-sentence)
- Thumbnail: [HH:MM:SS] (peak facial/reaction/emotional beat)

No meta-text. Output only the formatted responses.`;
};

export interface EnrichmentRubricCandidate {
  id: number;
  timestamp: string;
  hook: string;
  coldOpen: string;
  flash: string;
  naturalEnd: string;
  thumbnail: string;
}

export const UNIFIED_ENRICHMENT_RUBRIC = (candidates: EnrichmentRubricCandidate[]): string => {
  const list = candidates
    .map(
      (c) =>
        `${c.id}. [${c.timestamp}] — ${c.hook}\n   Cold open: ${c.coldOpen} | Flash: ${c.flash} | End: ${c.naturalEnd} | Thumbnail: ${c.thumbnail}`,
    )
    .join("\n");

  return `Score each candidate on the 4-axis virality rubric and provide title variants.

Candidates:
${list}

For each, provide EXACTLY:

**N. [HH:MM:SS] — Short label**
- Hook: N/25 (0 = no reason to not swipe, 25 = irresistible first 2 seconds)
- Flow: N/25 (0 = dead air / tangents, 25 = every second earns its place)
- Engagement: N/25 (0 = passive viewing, 25 = triggers comments/saves/shares)
- Humor: N/25 (0 = odd/nothing happens, 25 = genuine LOL / try-not-to-laugh)
- Trend: N/25 (0 = dated, 25 = hits current meme/cultural beat)
- Total: N/100
- Funny quote: Yes/No
- LOL potential: N/5
- Title drafts:
  1. Direct funny quote if available (≤60 chars)
  2. WTF just happened / shock hook
  3. Payoff-first title

Be harsh — 20+ means top-tier. Output only the formatted responses.`;
};
