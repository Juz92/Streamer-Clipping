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
    *   **Broad Appeal:** Yes or No (would someone who has never played this game find this funny with zero context?)

Return a numbered list ranked by viral potential. Be selective — 15 strong picks is better than 30 mediocre ones. Prioritise moments that score Yes on Broad Appeal — these go viral fastest on new channels.`;

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

export const QUERY_FRIEND_ROASTS = `Fourth question — friend roast escalations. Identify 5-10 moments where the friend group roasts each other in back-and-forth chains that escalate. This is the #1 clip type for this channel: one person says something, another one-ups it, the group commits to the bit until someone breaks.

Look for: callouts that get personal, playful ribbing that turns into a full group pile-on, moments where someone gets dunked on repeatedly, or a single devastating comeback that ends the exchange. The key is ESCALATION — not just a single joke, but a chain reaction.

For each, provide EXACTLY this format:

N. **Short Title**
    *   **Timestamp:** [HH:MM:SS] (where the roast CHAIN starts — include the setup, not just the punchline)
    *   **Hook:** One sentence capturing the roast arc
    *   **Quote:** The best line from the exchange (peak of the escalation)
    *   **Parties involved:** Who is roasting who
    *   **Setup Needed:** Yes or No

Return 5-10 picks, ranked by how much the group escalation adds to viral potential.`;

export const QUERY_CRASH_OUTS = `Fifth question — crash-outs and tilt spirals. Identify 5-10 moments where Peanut or a teammate completely loses composure: escalating frustration chains, rage quit threats, increasingly absurd blame deflection, or meltdowns that friends pile on with roasting.

NOT a single loud reaction — look for the ESCALATION ARC: annoyance → frustration → full meltdown. Best crash-outs: someone threatens to quit and keeps playing, or blame excuses get more and more absurd, or tilt + friends roasting the tilt simultaneously.

For each, provide EXACTLY this format:

N. **Short Title**
    *   **Timestamp:** [HH:MM:SS] (START of the escalation, not just the peak moment)
    *   **Hook:** One sentence describing the crash-out arc
    *   **Crash type:** one of: rage-spiral / blame-deflection / rage-quit-threat / tilt-plus-roast / meltdown
    *   **Setup Needed:** Yes or No

Return 5-10 picks, ranked by how funny the escalation arc is (not just how loud the peak moment is).`;

export const QUERY_ONE_LINERS = `Sixth question — quotable one-liners. Identify 10-15 standalone zingers, punchlines, metaphors, or unexpected phrasings between 5 and 15 words long. These feed thumbnails and title cards — they do not need to be standalone clips.

For each, provide EXACTLY this format:

N. **"The exact quote"**
    *   **Timestamp:** [HH:MM:SS]
    *   **Context:** One sentence of context
    *   **Why it's quotable:** Why this line is memeable / thumbnail-worthy
    *   **Broad Appeal:** Yes or No (would someone who has never played this game understand why this is funny or surprising?)

Return 10-15 picks. Prioritize lines that score Yes on Broad Appeal — a one-liner that requires zero gaming knowledge to land is worth 3x a game-specific reference.`;

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
- Hook: N/25 (0 = no reason to not swipe, 25 = irresistible first 2 seconds — cold-open promises payoff, visual/audio curiosity, impossible-to-miss)
- Flow: N/25 (0 = dead air / tangents mid-clip, 25 = every second earns its place, no dips)
- Engagement: N/25 (0 = passive viewing, 25 = triggers comments, saves, shares — something the viewer will tag a friend on)
- Trend: N/25 (0 = timeless but dated, 25 = hits a current meme, game moment, or cultural beat people are already talking about)
- Title drafts:
  1. First title variant (≤60 chars, hook-style)
  2. Second title variant (curiosity gap)
  3. Third title variant (payoff-first)

The four rubric dimensions sum to a 0-100 virality rating. Be harsh — 20+ in any dimension means the clip is top-tier along that axis. Be precise with timestamps — these drive clip rendering.`;
};

export const ALL_QUERIES = [
  { key: "humor", prompt: QUERY_HUMOR },
  { key: "running-bits", prompt: QUERY_RUNNING_BITS },
  { key: "emotional-peaks", prompt: QUERY_EMOTIONAL_PEAKS },
  { key: "friend-roasts", prompt: QUERY_FRIEND_ROASTS },
  { key: "crash-outs", prompt: QUERY_CRASH_OUTS },
  { key: "one-liners", prompt: QUERY_ONE_LINERS },
  { key: "story-of-stream", prompt: QUERY_STORY_OF_STREAM },
] as const;
