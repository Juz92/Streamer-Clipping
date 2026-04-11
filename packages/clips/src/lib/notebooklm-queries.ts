/**
 * The 8 NotebookLM queries the review module runs against each stream
 * transcript. Each prompt specifies an exact output format so the parser
 * in notebooklm-parser.ts can extract structured fields reliably.
 *
 * Queries 2-8 chain via --conversation-id from query 1 so NotebookLM
 * remembers context across the query set (e.g., query 2 can exclude
 * things it already surfaced in query 1).
 */

export const QUERY_HUMOR = `You are reviewing a transcript from an 11-hour livestream of gaming YouTuber 'The Burnt Peanut' playing games like RUST or Halo. Your goal is to identify the TOP 15 MOMENTS that would make the funniest, most viral 9:16 YouTube Short clips (30-60 seconds each).

Focus on HUMOR — jokes, reactions, callbacks, absurd moments, timing, personality — not just loud excitement. An automated keyword scorer already catches generic 'loud reactions', so focus on things the scorer would MISS: dry jokes, ironic deliveries, setup-and-payoff pairs, callbacks to earlier moments, running bits, and moments where the humor comes from WHAT is said rather than HOW loud it is.

For each of the top 15 moments, provide EXACTLY this format:

N. **Short Title**
    *   **Timestamp:** [HH:MM:SS]
    *   **Hook Description:** One sentence suitable for a YouTube Short title
    *   **Quote:** "Direct quote from the transcript"
    *   **Why it's funny:** 1-2 sentences
    *   **Setup Needed:** Yes or No (if yes, note the earlier timestamp)
    *   **Humor Type:** one of: callback, running-bit, dry-joke, absurdist, reaction-gold, character-moment

Return a numbered list ranked by viral potential. Be selective — 15 strong picks is better than 30 mediocre ones.`;

export const QUERY_RUNNING_BITS = `Second question — different lens. Instead of individual moments, identify RUNNING BITS, INSIDE JOKES, and RECURRING THEMES that appear multiple times across the stream. These are patterns a keyword scorer cannot detect because they require remembering context across hours.

For each running bit, provide EXACTLY this format:

### N. The Bit Name
*   **Timestamps:** [HH:MM:SS], [HH:MM:SS], [HH:MM:SS]...
*   **Description:** One sentence describing the bit
*   **Best Single-Clip Candidate:** [HH:MM:SS] followed by a brief description of why this is the best standalone clip

Focus on things NOT in your previous top 15 answer. Return 8-12 running bits, ranked by comedy potential unlocked for compilation or themed clips.`;

export const QUERY_EMOTIONAL_PEAKS = `Third question — emotional peaks that are NOT pure comedy. Identify 8-10 moments with strong emotional intensity of any type: rage, wholesome, vulnerability, shock, triumph, cringe, genuine fear, resignation, explosive joy. These are often quiet peaks the keyword scorer misses (no audio spike, no CAPS).

For each moment, provide EXACTLY this format:

N. **Short Title — Emotion Type**
    *   **Timestamp:** [HH:MM:SS]
    *   **Hook:** One sentence hook description
    *   **Emotion:** rage / wholesome / triumph / vulnerability / shock / cringe / resignation / explosive-joy
    *   **Setup Needed:** Yes or No

Exclude moments already identified as humor picks. Focus on moments where the PERSON is the content, not the joke.`;

export const QUERY_HOT_TAKES = `Fourth question — hot takes and spicy opinions. Identify 5-10 moments where Peanut drops a controversial opinion, a strong take on games/streamers/industry, or a claim likely to drive comment engagement. These are comment-bait clips.

For each, provide EXACTLY this format:

N. **Short Title**
    *   **Timestamp:** [HH:MM:SS]
    *   **Hook:** One sentence
    *   **The take:** What specifically did he say (short paraphrase)
    *   **Why it's spicy:** What makes this engagement-bait
    *   **Setup Needed:** Yes or No

Return 5-10 picks, ranked by how much comment-section chaos they would start.`;

export const QUERY_DRAMA = `Fifth question — drama and conflict moments. Identify 5-10 moments of interpersonal heat: arguments with teammates, callouts against enemies, betrayals, trash-talk exchanges, beefs. This is NOT the same as rage (which is personal frustration) — drama is interpersonal.

For each, provide EXACTLY this format:

N. **Short Title**
    *   **Timestamp:** [HH:MM:SS]
    *   **Hook:** One sentence
    *   **Parties involved:** Who is in conflict
    *   **The conflict:** What's at stake
    *   **Setup Needed:** Yes or No

Return 5-10 picks, ranked by intensity.`;

export const QUERY_ONE_LINERS = `Sixth question — quotable one-liners. Identify 10-15 standalone zingers, punchlines, metaphors, or unexpected phrasings between 5 and 15 words long. These feed thumbnails and title cards — they do not need to be standalone clips.

For each, provide EXACTLY this format:

N. **"The exact quote"**
    *   **Timestamp:** [HH:MM:SS]
    *   **Context:** One sentence of context
    *   **Why it's quotable:** Why this line is memeable / thumbnail-worthy

Return 10-15 picks. Prioritize lines that would work as title overlays on thumbnails.`;

export const QUERY_STORY_OF_STREAM = `Seventh question — single hero pick. Out of everything in this 11-hour stream, what is THE moment? The single thing viewers would tell their friends about. The moment that defines this stream. This becomes our headline Short.

Provide EXACTLY this format:

### The Story of the Stream

**Timestamp:** [HH:MM:SS]
**Hook:** One-sentence hook
**Why this is THE moment:** 2-3 sentences on why this beats every other candidate

Return exactly one pick.`;

export const QUERY_ENRICHMENT_TEMPLATE = (
  candidates: Array<{ id: number; timestamp: string; hook: string }>,
): string => {
  const list = candidates
    .map((c) => `${c.id}. [${c.timestamp}] — ${c.hook}`)
    .join("\n");

  return `Final question — per-clip enrichment. For each candidate listed below, provide EXACTLY these fields so I can render tight, viral-optimized clips:

Candidates:
${list}

For each candidate, provide EXACTLY this format:

**N. [HH:MM:SS] — Short label**
- Cold open: [HH:MM:SS] (the exact timestamp where the clip should START for the strongest first-3-second hook — usually slightly before the main moment to catch the setup)
- Natural end: [HH:MM:SS] (the exact timestamp where the clip should END at a natural audio exit, never mid-sentence)
- Thumbnail: [HH:MM:SS] (single timestamp of the peak facial / reaction / emotional beat that would make the best thumbnail frame)
- Title drafts:
  1. First title variant (≤60 chars, hook-style)
  2. Second title variant (curiosity gap)
  3. Third title variant (payoff-first)

Be precise with timestamps — these drive clip rendering.`;
};

export const ALL_QUERIES = [
  { key: "humor", prompt: QUERY_HUMOR },
  { key: "running-bits", prompt: QUERY_RUNNING_BITS },
  { key: "emotional-peaks", prompt: QUERY_EMOTIONAL_PEAKS },
  { key: "hot-takes", prompt: QUERY_HOT_TAKES },
  { key: "drama", prompt: QUERY_DRAMA },
  { key: "one-liners", prompt: QUERY_ONE_LINERS },
  { key: "story-of-stream", prompt: QUERY_STORY_OF_STREAM },
] as const;
