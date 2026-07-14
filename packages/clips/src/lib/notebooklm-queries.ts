/**
 * The 8 NotebookLM queries the review module runs against each stream
 * transcript. Each prompt specifies an exact output format so the parser
 * in notebooklm-parser.ts can extract structured fields reliably.
 *
 * Queries 2-8 chain via --conversation-id from query 1 so NotebookLM
 * remembers context across the query set (e.g., query 2 can exclude
 * things it already surfaced in query 1).
 */

export const QUERY_HUMOR = `You are reviewing a transcript from a livestream of gaming YouTuber 'The Burnt Peanut' playing RUST or Halo. Your goal is to identify the TOP 15 MOMENTS that would make the funniest, most viral 9:16 YouTube Short clips (18-35 seconds each).

HARD FIRST-3-SECONDS RULE: If a moment does not have a strong visual or audio hook in the first 3 seconds that would make someone STOP SCROLLING, do NOT include it. The first 3 seconds must contain: a visible face/camera reaction, a loud audio spike, a shocking statement, or a clear visual payoff. No slow-build entries.

FLASH RULE: If the main viral moment happens after the first 3 seconds but there is a strong flash moment (reaction, one-liner, visual gag) within the first 4-8 seconds, you may use that flash as the cold open BEFORE the main content starts. In your output, specify both the flash timestamp and the main content timestamp.

VISIBILITY RULE: Only include moments where the streamer's face/camera/avatar is clearly visible and readable on screen. Moments where the screen is cluttered with HUD, menus, or dark gameplay-only footage are NOT good Shorts candidates.

Focus on HUMOR — jokes, reactions, callbacks, absurd moments, timing, personality. An automated keyword scorer already catches generic 'loud reactions', so focus on things the scorer would MISS: dry jokes, ironic deliveries, setup-and-payoff pairs, callbacks to earlier moments, running bits, and moments where the humor comes from WHAT is said rather than HOW loud it is.

LAYOUT HINT: For each moment, note whether the primary visual is GAMEPLAY (action on screen, explosions, building) or TALKING (streamer facing camera, monologue, reaction shot). This determines whether we use a 2-panel layout or portrait layout.

For each of the top 15 moments, provide EXACTLY this format:

N. **Short Title**
    *   **Timestamp:** [HH:MM:SS] (start of MAIN CONTENT — the viral moment itself)
    *   **Flash Timestamp:** [HH:MM:SS] or "none" (if there is a scroll-stopping flash within first 4-8s, list it here; otherwise "none")
    *   **Hook Description:** One sentence suitable for a YouTube Short title
    *   **Quote:** "Direct quote from the transcript"
    *   **Why it's funny:** 1-2 sentences
    *   **Setup Needed:** Yes or No (if yes, note the earlier timestamp)
    *   **Humor Type:** one of: callback, running-bit, dry-joke, absurdist, reaction-gold, character-moment
    *   **Broad Appeal:** Yes or No (would someone who has never played this game find this funny with zero context?)
    *   **Visual Type:** gameplay or talking (is the streamer's face/camera visible, or is it mostly gameplay footage?)

Return a numbered list ranked by viral potential. Be selective — 15 strong picks is better than 30 mediocre ones. Prioritise moments that score Yes on Broad Appeal.

IMPORTANT: Output ONLY the formatted picks. Do not include instructions, explanations, or meta-text like "Based on the transcript..." or "Here are the top moments...".`;

export const QUERY_RUNNING_BITS = `Second question — different lens. Instead of individual moments, identify RUNNING BITS, INSIDE JOKES, and RECURRING THEMES that appear multiple times across the stream. These are patterns a keyword scorer cannot detect because they require remembering context across hours.

For each running bit, provide EXACTLY this format:

### N. The Bit Name
*   **Timestamps:** [HH:MM:SS], [HH:MM:SS], [HH:MM:SS]...
*   **Description:** One sentence describing the bit
*   **Best Single-Clip Candidate:** [HH:MM:SS] followed by a brief description of why this is the best standalone clip
*   **Visual Type:** gameplay or talking

Focus on things NOT in your previous top 15 answer. Return 8-12 running bits, ranked by comedy potential unlocked for compilation or themed clips.

IMPORTANT: Output ONLY the formatted picks. Do not include instructions, explanations, or meta-text.`;

export const QUERY_EMOTIONAL_PEAKS = `Third question — emotional peaks that are NOT pure comedy. Identify 8-10 moments with strong emotional intensity of any type: rage, wholesome, vulnerability, shock, triumph, cringe, genuine fear, resignation, explosive joy. These are often quiet peaks the keyword scorer misses (no audio spike, no CAPS).

FIRST-3-SECONDS RULE: Every moment must have a strong hook in the first 3 seconds. No slow-build emotional arcs — the viewer must feel the emotion immediately.

VISIBILITY RULE: Only include moments where the streamer's face/camera is clearly visible. A quiet emotional moment with no visible reaction is not a good Short.

For each moment, provide EXACTLY this format:

N. **Short Title — Emotion Type**
    *   **Timestamp:** [HH:MM:SS]
    *   **Flash Timestamp:** [HH:MM:SS] or "none"
    *   **Hook:** One sentence hook description
    *   **Emotion:** rage / wholesome / triumph / vulnerability / shock / cringe / resignation / explosive-joy
    *   **Setup Needed:** Yes or No
    *   **Visual Type:** gameplay or talking

Exclude moments already identified as humor picks. Focus on moments where the PERSON is the content, not the joke.

IMPORTANT: Output ONLY the formatted picks. Do not include meta-text.`;

export const QUERY_FRIEND_ROASTS = `Fourth question — friend roast escalations. Identify 5-10 moments where the friend group roasts each other in back-and-forth chains that escalate. This is the #1 clip type for this channel: one person says something, another one-ups it, the group commits to the bit until someone breaks.

FIRST-3-SECONDS RULE: The roast chain must start strong — a devastating opening line or visible reaction within the first 3 seconds. No "wait for it" roast setups.

FLASH RULE: If the best burn comes later in the chain but there's a strong reaction or setup line in the first 4-8 seconds, specify a flash timestamp to use as the cold open.

VISIBILITY RULE: Roast chains work best when you can SEE who's getting roasted and who's delivering the burn. Face visibility matters more than gameplay action here.

Look for: callouts that get personal, playful ribbing that turns into a full group pile-on, moments where someone gets dunked on repeatedly, or a single devastating comeback that ends the exchange. The key is ESCALATION — not just a single joke, but a chain reaction.

For each, provide EXACTLY this format:

N. **Short Title**
    *   **Timestamp:** [HH:MM:SS] (where the roast CHAIN starts — include the setup, not just the punchline)
    *   **Flash Timestamp:** [HH:MM:SS] or "none"
    *   **Hook:** One sentence capturing the roast arc
    *   **Quote:** The best line from the exchange (peak of the escalation)
    *   **Parties involved:** Who is roasting who
    *   **Setup Needed:** Yes or No
    *   **Visual Type:** gameplay or talking

Return 5-10 picks, ranked by how much the group escalation adds to viral potential.

IMPORTANT: Output ONLY the formatted picks. Do not include meta-text.`;

export const QUERY_CRASH_OUTS = `Fifth question — crash-outs and tilt spirals. Identify 5-10 moments where Peanut or a teammate completely loses composure: escalating frustration chains, rage quit threats, increasingly absurd blame deflection, or meltdowns that friends pile on with roasting.

FIRST-3-SECONDS RULE: The crash-out must be visible/audible in the first 3 seconds. Either the trigger event is immediate or the streamer's reaction face tells the whole story upfront.

FLASH RULE: If the meltdown builds over time but there's a strong reaction or trigger moment in the first 4-8 seconds, specify a flash timestamp for the cold open.

NOT a single loud reaction — look for the ESCALATION ARC: annoyance → frustration → full meltdown. Best crash-outs: someone threatens to quit and keeps playing, or blame excuses get more and more absurd, or tilt + friends roasting the tilt simultaneously.

For each, provide EXACTLY this format:

N. **Short Title**
    *   **Timestamp:** [HH:MM:SS] (START of the escalation, not just the peak moment)
    *   **Flash Timestamp:** [HH:MM:SS] or "none"
    *   **Hook:** One sentence describing the crash-out arc
    *   **Crash type:** one of: rage-spiral / blame-deflection / rage-quit-threat / tilt-plus-roast / meltdown
    *   **Setup Needed:** Yes or No
    *   **Visual Type:** gameplay or talking

Return 5-10 picks, ranked by how funny the escalation arc is (not just how loud the peak moment is).

IMPORTANT: Output ONLY the formatted picks. Do not include meta-text.`;

export const QUERY_ONE_LINERS = `Sixth question — quotable one-liners. Identify 10-15 standalone zingers, punchlines, metaphors, or unexpected phrasings between 5 and 15 words long. These feed thumbnails and title cards — they do not need to be standalone clips.

For each, provide EXACTLY this format:

N. **"The exact quote"**
    *   **Timestamp:** [HH:MM:SS]
    *   **Context:** One sentence of context
    *   **Why it's quotable:** Why this line is memeable / thumbnail-worthy
    *   **Broad Appeal:** Yes or No (would someone who has never played this game understand why this is funny or surprising?)
    *   **Visual Type:** gameplay or talking

Return 10-15 picks. Prioritize lines that score Yes on Broad Appeal — a one-liner that requires zero gaming knowledge to land is worth 3x a game-specific reference.

IMPORTANT: Output ONLY the formatted picks. Do not include meta-text.`;

export const QUERY_STORY_OF_STREAM = `Seventh question — single hero pick. Out of everything in this stream, what is THE moment? The single thing viewers would tell their friends about. The moment that defines this stream. This becomes our headline Short.

FIRST-3-SECONDS RULE: The story moment must have immediate impact. No "you had to be there" moments — it must work for someone who has never seen this streamer before.

Provide EXACTLY this format:

### The Story of the Stream

**Timestamp:** [HH:MM:SS]
**Flash Timestamp:** [HH:MM:SS] or "none"
**Hook:** One-sentence hook
**Visual Type:** gameplay or talking
**Why this is THE moment:** 2-3 sentences on why this beats every other candidate

Return exactly one pick.

IMPORTANT: Output ONLY the formatted pick. Do not include meta-text.`;

export const QUERY_ENRICHMENT_TIMESTAMPS = (
  candidates: Array<{ id: number; timestamp: string; hook: string }>,
): string => {
  const list = candidates
    .map((c) => `${c.id}. [${c.timestamp}] — ${c.hook}`)
    .join("\n");

  return `For each candidate listed below, provide EXACTLY these timestamp fields. Be precise — these drive clip rendering.

Candidates:
${list}

For each candidate, provide EXACTLY this format:

**N. [HH:MM:SS] — Short label**
- Cold open: [HH:MM:SS] (where the clip should START — usually 2-5 seconds before the main moment to catch the setup/reaction; if the first 3 seconds of the main moment are already strong, use the main moment timestamp)
- Flash timestamp: [HH:MM:SS] or "none" (if there is a stronger scroll-stopping moment within the first 4-8 seconds that should be shown BEFORE the main content starts, list it here; otherwise "none")
- Natural end: [HH:MM:SS] (where the clip should END at a clean audio exit, never mid-sentence)
- Thumbnail: [HH:MM:SS] (single timestamp of the peak facial / reaction / emotional beat)

If a candidate has no strong flash moment in the first 4-8 seconds, set Flash timestamp to "none" and Cold open to the main moment's start.`;
};

export const QUERY_ENRICHMENT_RUBRIC = (
  candidates: Array<{ id: number; timestamp: string; hook: string; coldOpen: string; flash: string; naturalEnd: string; thumbnail: string }>,
): string => {
  const list = candidates
    .map((c) => `${c.id}. [${c.timestamp}] — ${c.hook}\n   Cold open: ${c.coldOpen} | Flash: ${c.flash} | End: ${c.naturalEnd} | Thumbnail: ${c.thumbnail}`)
    .join("\n");

  return `For each candidate listed below, score it on the 4-axis virality rubric and provide title variants.

Candidates:
${list}

For each candidate, provide EXACTLY this format:

**N. [HH:MM:SS] — Short label**
- Hook: N/25 (0 = no reason to not swipe, 25 = irresistible first 2 seconds)
- Flow: N/25 (0 = dead air / tangents mid-clip, 25 = every second earns its place)
- Engagement: N/25 (0 = passive viewing, 25 = triggers comments, saves, shares)
- Trend: N/25 (0 = timeless but dated, 25 = hits current meme / cultural beat)
- Total: N/100
- Title drafts:
  1. First title variant (≤60 chars, hook-style)
  2. Second title variant (curiosity gap)
  3. Third title variant (payoff-first)

Be harsh — 20+ in any dimension means the clip is top-tier along that axis. Output ONLY the formatted responses.`;
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
