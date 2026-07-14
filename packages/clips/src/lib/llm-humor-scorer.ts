/**
 * llm-humor-scorer.ts — LLM-based humor detection for YouTube Shorts clips.
 *
 * This module sends scene transcripts to an LLM (Claude/GPT) and gets back
 * a structured humor analysis. It replaces the regex-based pattern detection
 * with actual understanding of comedic timing, irony, callbacks, and viral potential.
 *
 * Design goals:
 *   - Fast: batch multiple scenes per API call
 *   - Cheap: use the cheapest model that can read transcripts (Claude Haiku / GPT-4o-mini)
 *   - Structured: returns JSON with humor_score, flash_time, end_time, why_funny
 *   - Cached: stores LLM responses to avoid re-analyzing the same scenes
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { ContentLane, PayoffType } from "./content-lanes.js";
import { normalizeContentLane, normalizePayoffType } from "./content-lanes.js";

// Load .env file if present (for OPENROUTER_API_KEY, etc.)
function loadEnvFile(): void {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
loadEnvFile();

export interface LLMHumorResult {
  humorScore: number;        // 0-1, how funny is this scene
  laughOutLoudScore: number; // 0-1, likelihood a cold viewer audibly laughs
  contentLane: ContentLane;  // what kind of Peanut content this is
  payoffType: PayoffType;    // why a cold viewer keeps watching
  laneScore: number;         // 0-1, strength within the selected lane
  flashTimeSec: number;      // when the "flash" (peak moment) should be
  endTimeSec: number;        // natural endpoint — where the joke resolves
  whyFunny: string;          // one-sentence explanation for the humor
  whyWorthWatching: string;  // one-sentence lane-specific premise/escalation/payoff
  confidence: number;        // 0-1, how confident the LLM is
  tags: string[];            // humor tags: "punchline", "roast", "callback", "irony", "self-deprecation", "visual-gag", "reaction", "silence-then-explosion", etc.
}

export interface LLMSceneRequest {
  sceneId: string;
  startSec: number;
  endSec: number;
  transcript: string;        // formatted transcript with timestamps
  chatSummary: string;       // top chat messages in this window
  audioSummary: string;      // audio characteristics (loud/quiet/spike times)
}

const CACHE_DIR = join(process.cwd(), "data", "llm-cache");
const PROMPT_VERSION = "personality-lanes-v2";

function simpleHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function getSceneCacheKey(scene: LLMSceneRequest): string {
  // Include content, not just sceneId, so different streams don't reuse stale scene-001 scores.
  const fingerprint = [
    PROMPT_VERSION,
    scene.sceneId,
    scene.startSec.toFixed(1),
    scene.endSec.toFixed(1),
    scene.transcript.slice(0, 1200),
    scene.chatSummary.slice(0, 400),
    scene.audioSummary,
  ].join("|");
  return scene.sceneId + "-" + simpleHash(fingerprint);
}

function getCachePath(cacheKey: string): string {
  return join(CACHE_DIR, cacheKey + ".json");
}

function loadCache(cacheKey: string): LLMHumorResult | null {
  const path = getCachePath(cacheKey);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LLMHumorResult;
  } catch {
    return null;
  }
}

function saveCache(cacheKey: string, result: LLMHumorResult): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(getCachePath(cacheKey), JSON.stringify(result, null, 2), "utf-8");
}

/* ── PROMPT BUILDER ── */
function buildPrompt(scenes: LLMSceneRequest[]): string {
  const sceneTexts: string[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    sceneTexts.push(
      "--- SCENE " + (i + 1) + " [" + s.sceneId + "] ---\n" +
      "Time: " + formatTime(s.startSec) + " → " + formatTime(s.endSec) + "\n" +
      "TRANSCRIPT:\n" + s.transcript + "\n\n" +
      "CHAT:\n" + s.chatSummary + "\n\n" +
      "AUDIO:\n" + s.audioSummary + "\n"
    );
  }
  const sceneText = sceneTexts.join("\n\n");

  return "You are a professional YouTube Shorts clip analyst for The Burnt Peanut gaming channel. Your job is to identify moments that will go viral (1M+ views).\n\n" +
    "Here are transcripts from ACTUAL viral hits on this channel (4.9M–9.9M views each). Study them:\n\n" +
    "HIT #1 — 'The Lebron James of Arc Raiders' (9.9M views, 25s):\n" +
    "Transcript: 'Don't worry, Koshi, I'll get this if I can figure it out. Oh, we, I got wait wait wait. Got it! Wait, you know, what are you? Is that what? We're brought James! Hey! Didn't you see that? Didn't you see that?'\n" +
    "Why it worked: Absurdist misidentification ('We're brought James!') + repetition loop ('Didn't you see that?' x2) + panic energy. No traditional joke structure — just chaos.\n\n" +
    "HIT #2 — 'It Indeed Did' (9.7M views, 35s):\n" +
    "Transcript: 'Oh What my gun doesn't work. Yes, it dies. I'm telling you it doesn't work. Oh, watch it. Good man. Watch it watch it watch it watch this watch Watch see Look see What It doesn't work What you what Does mine work?'\n" +
    "Why it worked: Repetition loop ('watch it' x5, 'doesn't work' x3) + escalating denial + friend disbelief. The humor is the LOOP, not a punchline.\n\n" +
    "HIT #3 — 'He Knew The Rules' (7.6M views, 42s):\n" +
    "Transcript: 'I see your laser. I see your laser. You have some upward angle... You turn that laser back on your main. You turn that laser back on. Thank you. Thank you. Hey. You turn that laser back on right now. Thank you. Thank you. All right, buddy. You turn that laser back on. If you turn off one more time, I'm going to get you. I'm going to get you. There we go. Don't you dare to the laser back off. Don't you dare. I told you not to do it!'\n" +
    "Why it worked: Repetition loop ('turn that laser back on' x4) + threat escalation + betrayal when laser goes off. Sustained 42s arc of mounting tension.\n\n" +
    "HIT #4 — 'Quick Somebody Grab Ninja's reboot card' (7.4M views, 26s):\n" +
    "Transcript: 'I don't know if I should be down now. Are you ready? Yeah! Practing the other one. Huh? I got down one, cracked one. What did you do? I did. Down another one down, the water's fine. Headshot one. Down another one. Ah. They're my heart. My heart. My heart.'\n" +
    "Why it worked: Sustained action sequence ('down another one' x3) + panic reaction ('My heart' x3). The clip is pure adrenaline + disbelief.\n\n" +
    "HIT #5 — 'ITS P-TUBER' (7.0M views, 69s):\n" +
    "Transcript: 'Are you a, uh, V2, better? Well. That's the last mistake you're gonna make you piece of shit. Wait, no, no, no, I was just curious... That's the last mistake you're gonna make. You tumble fucking shit. I'm kidding, I'm just kidding... You want some of this, motherfucker! I'm right here! I'm going in! ... So the left, you ran to the left, you ran to the left, you ran to the left. I'd never die to a V2, bro. Well, you better get ready! ... What hacks did you just install?'\n" +
    "Why it worked: Friendly betrayal ('last mistake') → panic spiral → chat accusation ('What hacks'). 69s of sustained social drama.\n\n" +
    "HIT #6 — 'First Day On The Job' (4.9M views, 24s):\n" +
    "Transcript: 'Foolish bitch. Foolish bitch. Guess you, what is that man? You're fucking dead. The fuck is going on?'\n" +
    "Why it worked: Repetition ('Foolish bitch' x2) + confusion spiral. Short, punchy, inexplicable chaos.\n\n" +
    "═══ VIRAL FORMULA FOR THIS CHANNEL ═══\n" +
    "1. REPETITION LOOPS (highest signal): Same phrase 3+ times with escalating energy. Score 0.85+ immediately.\n" +
    "2. FRIENDLY BETRAYAL / PANIC SPIRALS: 'I'm kidding' after threatening someone, 'I told you not to do it', 'What did you do?'\n" +
    "3. SUSTAINED CHAOS (20-45s): Not a single moment — a sustained arc of mounting absurdity. The 69s hit proves longer arcs work.\n" +
    "4. ABSURDIST MISIDENTIFICATION: Calling something completely wrong ('Lebron James', 'P-TUBER') with total confidence.\n" +
    "5. CHAT ACCUSATIONS / ROASTS: Chat calling out the streamer, streamer defensively reacting.\n" +
    "6. CONFUSION SPIRALS: 'What is that?' 'What's going on?' — genuine bewilderment is funny.\n\n" +
    "═══ WHAT DOES NOT WORK ON THIS CHANNEL ═══\n" +
    "- Traditional setup→punchline jokes (this channel doesn't do stand-up)\n" +
    "- Gambling wins/losses without social drama\n" +
    "- Generic screaming without repetition or betrayal context\n" +
    "- Generic solo single kills or aimless combat with no exceptional sequence\n" +
    "- 'That's', 'see', 'this' as visual gags (already filtered)\n\n" +
    "═══ CONTENT LANE — CHOOSE EXACTLY ONE ═══\n" +
    "- peanut-bits: Peanut's story, take, roast, creator-meta riff, or improvised character is the product. Quiet gameplay is allowed when the premise and payoff are strong.\n" +
    "- squad-chaos: friend-group plan, betrayal, argument, blame, roleplay, or instant karma creates a complete social story.\n" +
    "- wtf-game-moments: a bizarre weapon, enemy, mechanic, glitch, or visual discovery is understandable without game knowledge.\n" +
    "- peanut-plays: an exceptional connected sequence — multi-kill, clutch, comeback, impossible shot, or domination. Reject isolated ordinary kills.\n" +
    "- the-mission: a clear objective/challenge, meaningful progress or jeopardy, and a visible result occur in the same self-contained arc.\n" +
    "- reject: generic chatter, tactical noise, isolated action, unclear context, or a scene that does not strongly satisfy one lane.\n\n" +
    "Choose one PAYOFF TYPE from: lol, roast, wow, wtf, tension, satisfaction, none.\n" +
    "LANE SCORE is 0-1 strength inside the chosen lane, not general energy. Use 0.80+ only when a cold viewer gets the premise and payoff. If visuals are required but not proven by transcript/chat/audio, lower confidence.\n\n" +
    "Examples from these streams: Love Island normal-guy riff = peanut-bits/lol; teammate kills Peanut = squad-chaos/roast; flaming chicken = wtf-game-moments/wtf; repeated connected kills = peanut-plays/wow; Black Key objective with result = the-mission/satisfaction.\n\n" +
    "For EACH scene below, analyze:\n" +
    "1. HUMOR SCORE (0-1): Would THIS CHANNEL'S audience rewatch?\n" +
    "2. LAUGH-OUT-LOUD SCORE (0-1): Likelihood a cold viewer with no game context audibly laughs. A smile or generic excitement is <=0.50; reserve 0.75+ for a clear premise, escalation, and comic payoff.\n" +
    "3. CONTENT LANE: Choose exactly one allowed lane.\n" +
    "4. PAYOFF TYPE: Choose exactly one allowed payoff.\n" +
    "5. LANE SCORE (0-1): Strength inside that lane; do not confuse energy with quality.\n" +
    "6. FLASH TIME (seconds): The best scroll-stopping moment — distinctive premise, betrayal, discovery, skill peak, or mission jeopardy.\n" +
    "7. NATURAL ENDPOINT (seconds): Where the selected lane's payoff resolves. Cut AFTER the final reaction/result.\n" +
    "8. WHY WORTH WATCHING: State the premise, escalation, and payoff. If any is missing, say so.\n" +
    "9. CONFIDENCE (0-1): How sure are you this lane and payoff are visible from available evidence?\n" +
    "10. TAGS: Array of tags from this list ONLY: repetition-loop, friendly-betrayal, panic-spiral, absurdist-misid, chat-roast, confusion-spiral, sustained-chaos, action-sequence, multi-kill, clutch, mission, game-discovery, creator-meta, storytime, character-bit\n\n" +
    "HUMOR / LAUGH-OUT-LOUD RUBRIC (calibrate against the 6 comedy hits above):\n" +
    "- 0.90-1.00: Clear repetition loop (3+ same phrase) OR sustained panic spiral with betrayal. This is hit material.\n" +
    "- 0.80-0.89: Strong social dynamic (betrayal, chat roast, accusation) with good energy. Likely viral.\n" +
    "- 0.70-0.79: Sustained chaos or confusion spiral with some structure. Worth clipping.\n" +
    "- 0.50-0.69: Mildly amusing, some energy but weak pattern. Borderline — only clip if nothing better.\n" +
    "- <0.50: Boring/filler. Skip.\n\n" +
    "LANE SCORE RUBRIC — SCORE THE CHOSEN LANE INDEPENDENTLY OF COMEDY:\n" +
    "- PEANUT BITS 0.80+: Peanut has a clear premise, take, story, character, creator-meta point, or viewer comeback that carries even over quiet gameplay.\n" +
    "- SQUAD CHAOS 0.80+: Friend dynamics create a clear betrayal, blame, failed plan, argument, roleplay, or instant-karma payoff.\n" +
    "- WTF GAME MOMENTS 0.80+: A cold viewer can understand the bizarre discovery, mechanic, glitch, enemy, weapon, or visual event without game lore.\n" +
    "- PEANUT PLAYS 0.80+: An obvious multi-kill sequence, clutch, comeback, domination run, or exceptional skill peak with a visible result. DO NOT penalize this lane for lacking a joke or social drama; generic single kills remain below 0.60.\n" +
    "- THE MISSION 0.80+: The window contains a clear objective, meaningful progress/jeopardy, and a definitive result. A complete duel, defence, escape, or quest can qualify without comedy.\n" +
    "- A scene may score 0.90 in PEANUT PLAYS or THE MISSION while scoring 0.20 in HUMOR and LAUGH-OUT-LOUD. That is correct.\n" +
    "- If no lane has a cold-viewer premise and payoff, choose reject even when the scene is loud.\n\n" +
    "CRITICAL RULES:\n" +
    "- Repetition is NOT funny by itself. Tactical/filler commands such as 'go', 'get him', 'hold', 'all right', 'I'm dead', and generic screaming do not qualify. A repetition loop must repeat a distinctive phrase while the meaning, social tension, or absurdity escalates.\n" +
    "- If a scene has friendly betrayal + panic reaction, score MUST be 0.75+\n" +
    "- If a scene is just loud combat, generic panic, gameplay competence, or screaming with no comic premise/payoff, cap HUMOR at 0.55 and LAUGH-OUT-LOUD at 0.45\n" +
    "- Repeated kill/score callouts such as 'I got one', 'down another', 'get him', or tactical orders are action, not comedy, unless a clear reversal, roast, absurd misidentification, or social payoff follows. Cap LAUGH-OUT-LOUD at 0.50 otherwise.\n" +
    "- Do not infer comedy from energy. A complete action arc can still be unfunny.\n" +
    "- Flash time should be AT the first distinctive repetition or betrayal moment, not before\n" +
    "- End time should be AFTER the final repetition or when panic exhausts (usually 3-5s after last peak)\n\n" +
    "Respond in STRICT JSON format (no markdown, no explanations outside JSON):\n\n" +
    "{\n" +
    "  \"scenes\": [\n" +
    "    {\n" +
    "      \"sceneId\": \"scene-001\",\n" +
    "      \"humorScore\": 0.85,\n" +
    "      \"laughOutLoudScore\": 0.82,\n" +
    "      \"contentLane\": \"peanut-bits\",\n" +
    "      \"payoffType\": \"lol\",\n" +
    "      \"laneScore\": 0.88,\n" +
    "      \"flashTimeSec\": 45.2,\n" +
    "      \"endTimeSec\": 52.0,\n" +
    "      \"whyFunny\": \"Repetition loop: 'watch it' said 5 times with escalating friend disbelief\",\n" +
    "      \"whyWorthWatching\": \"Peanut's confident demand escalates through friend disbelief and resolves in a comic failure.\",\n" +
    "      \"confidence\": 0.9,\n" +
    "      \"tags\": [\"repetition-loop\", \"panic-spiral\"]\n" +
    "    }\n" +
    "  ]\n" +
    "}\n\n" +
    sceneText + "\n\n" +
    "STRICT JSON RESPONSE ONLY:";
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ":" + String(s).padStart(2, "0");
}

/* ── API CALL ── */
async function callLLM(prompt: string): Promise<string> {
  // Priority: OpenRouter (DeepSeek) > Anthropic > OpenAI
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (openrouterKey) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + openrouterKey,
          "HTTP-Referer": "https://github.com/justinhilliard/streamer-clipping",
          "X-Title": "Streamer Clip Pipeline",
        },
        body: JSON.stringify({
          model: "deepseek/deepseek-v4-flash",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error("OpenRouter API error: " + response.status + " " + error);
      }

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (err) {
      console.warn("OpenRouter failed, trying Anthropic:", err);
    }
  }

  if (anthropicKey) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          max_tokens: 4096,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error("Anthropic API error: " + response.status + " " + error);
      }

      const data = await response.json();
      return data.content[0].text;
    } catch (err) {
      console.warn("Anthropic failed, trying OpenAI:", err);
    }
  }

  if (openaiKey) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + openaiKey,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error("OpenAI API error: " + response.status + " " + error);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  throw new Error("No LLM API key found. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY.");
}

export function parseLLMResponse(raw: string | null | undefined, sceneIds: string[]): Map<string, LLMHumorResult> {
  const results = new Map<string, LLMHumorResult>();
  const source = typeof raw === "string" ? raw : "";

  // Extract JSON from response (handle markdown code blocks)
  let jsonText = source.trim() ? source : '{"scenes":[]}';
  const codeBlockMatch = source.match(/```json\s*([\s\S]*?)```/);
  if (codeBlockMatch) jsonText = codeBlockMatch[1];
  else {
    const plainJsonMatch = source.match(/(\{[\s\S]*\})/);
    if (plainJsonMatch) jsonText = plainJsonMatch[1];
  }

  try {
    const parsed = JSON.parse(jsonText);
    const scenes = parsed.scenes || parsed;
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const sceneId = s.sceneId || s.scene_id;
      if (!sceneId) continue;
      const contentLane = normalizeContentLane(s.contentLane ?? s.content_lane) ?? "reject";
      const payoffType = normalizePayoffType(s.payoffType ?? s.payoff_type);
      const whyFunny = s.whyFunny ?? s.why_funny ?? "";
      const whyWorthWatching = s.whyWorthWatching ?? s.why_worth_watching ?? s.why ?? whyFunny;
      results.set(sceneId, {
        humorScore: clamp01(s.humorScore ?? s.humor_score ?? 0),
        laughOutLoudScore: clamp01(
          s.laughOutLoudScore ??
          s.laugh_out_loud_score ??
          Math.min(s.humorScore ?? s.humor_score ?? 0, 0.5)
        ),
        contentLane,
        payoffType,
        laneScore: clamp01(s.laneScore ?? s.lane_score ?? 0),
        flashTimeSec: s.flashTimeSec ?? s.flash_time_sec ?? 0,
        endTimeSec: s.endTimeSec ?? s.end_time_sec ?? 0,
        whyFunny,
        whyWorthWatching,
        confidence: clamp01(s.confidence ?? 0.5),
        tags: Array.isArray(s.tags) ? s.tags : [],
      });
    }
  } catch (err) {
    console.error("Failed to parse LLM response:", err);
    console.error("Raw response:", source.substring(0, 500));
  }

  // Fill missing results with defaults
  for (let i = 0; i < sceneIds.length; i++) {
    const id = sceneIds[i];
    if (!results.has(id)) {
      results.set(id, {
        humorScore: 0.3,
        laughOutLoudScore: 0.2,
        contentLane: "reject",
        payoffType: "none",
        laneScore: 0,
        flashTimeSec: 0,
        endTimeSec: 0,
        whyFunny: "Failed to parse LLM response",
        whyWorthWatching: "Failed to parse LLM response",
        confidence: 0.1,
        tags: ["parse-error"],
      });
    }
  }

  return results;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Keep high-energy-but-unfunny scenes below the shortlist line. */
export function blendComedyScore(humorScore: number, laughOutLoudScore: number): number {
  const humor = clamp01(humorScore);
  const lol = clamp01(laughOutLoudScore);
  const blended = humor * 0.3 + lol * 0.7;
  return lol < 0.55 ? Math.min(blended, 0.49) : clamp01(blended);
}

export function passesAutomaticComedyFloor(laughOutLoudScore: number): boolean {
  return laughOutLoudScore >= 0.65;
}

/* ── MAIN EXPORT ── */
export async function scoreScenesWithLLM(
  scenes: LLMSceneRequest[],
  batchSize = 5,
): Promise<Map<string, LLMHumorResult>> {
  const results = new Map<string, LLMHumorResult>();

  // Check cache first
  const uncachedScenes: LLMSceneRequest[] = [];
  for (const scene of scenes) {
    const cached = loadCache(getSceneCacheKey(scene));
    if (cached) {
      results.set(scene.sceneId, cached);
    } else {
      uncachedScenes.push(scene);
    }
  }

  if (uncachedScenes.length === 0) {
    console.log("[LLM] All " + scenes.length + " scenes loaded from cache");
    return results;
  }

  console.log("[LLM] Analyzing " + uncachedScenes.length + " scenes in batches of " + batchSize + "...");

  // Process in batches
  for (let i = 0; i < uncachedScenes.length; i += batchSize) {
    const batch = uncachedScenes.slice(i, i + batchSize);
    const prompt = buildPrompt(batch);

    try {
      const rawResponse = await callLLM(prompt);
      const batchResults = parseLLMResponse(rawResponse, batch.map(function(s) { return s.sceneId; }));

      // Iterate Map without for-of (downlevelIteration compatibility)
      const batchResultIds: string[] = [];
      batchResults.forEach(function(_val: LLMHumorResult, key: string) { batchResultIds.push(key); });
      for (let j = 0; j < batchResultIds.length; j++) {
        const sceneId = batchResultIds[j];
        const result = batchResults.get(sceneId)!;
        let sourceScene: LLMSceneRequest | null = null;
        for (let k = 0; k < batch.length; k++) {
          if (batch[k].sceneId === sceneId) {
            sourceScene = batch[k];
            break;
          }
        }
        saveCache(sourceScene ? getSceneCacheKey(sourceScene) : sceneId, result);
        results.set(sceneId, result);
      }

      console.log("[LLM] Batch " + (Math.floor(i / batchSize) + 1) + "/" + Math.ceil(uncachedScenes.length / batchSize) + " complete");
    } catch (err) {
      console.error("[LLM] Batch failed:", err);
      // Fill with defaults for failed batch
      for (const scene of batch) {
        const fallback: LLMHumorResult = {
          humorScore: 0.3,
          laughOutLoudScore: 0.2,
          contentLane: "reject",
          payoffType: "none",
          laneScore: 0,
          flashTimeSec: scene.startSec + (scene.endSec - scene.startSec) * 0.5,
          endTimeSec: scene.endSec,
          whyFunny: "LLM analysis failed — using fallback",
          whyWorthWatching: "LLM analysis failed — using fallback",
          confidence: 0.1,
          tags: ["llm-error"],
        };
        results.set(scene.sceneId, fallback);
      }
    }
  }

  return results;
}

/* ── HELPERS: Build requests from Scene objects ── */
export function buildLLMRequestFromScene(
  scene: any, // Scene type from scene-segmenter.ts
  sceneId: string,
): LLMSceneRequest {
  // Format transcript with timestamps
  const transcriptLines: string[] = [];
  const words = scene.words || [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const time = formatTime(w.startMs / 1000);
    transcriptLines.push("[" + time + "] " + w.word);
  }

  // Format chat summary (top 15 messages)
  const messages = scene.messages || [];
  const chatLines: string[] = [];
  for (let i = 0; i < Math.min(messages.length, 15); i++) {
    const m = messages[i];
    chatLines.push("[" + formatTime(m.timestampSec) + "] " + m.text);
  }

  // Format audio summary
  const audio = scene.audio || {};
  const audioSummary = "Mean: " + (audio.meanRms?.toFixed(1) ?? "?") + "dB | Max: " + (audio.maxRms?.toFixed(1) ?? "?") + "dB | Range: " + (audio.rmsRange?.toFixed(1) ?? "?") + "dB | Valley→Peak: " + (audio.hasValleyToPeak ? "YES" : "no");

  return {
    sceneId,
    startSec: scene.startSec,
    endSec: scene.endSec,
    transcript: transcriptLines.join(" ") || "(no transcript)",
    chatSummary: chatLines.join("\n") || "(no chat)",
    audioSummary,
  };
}
