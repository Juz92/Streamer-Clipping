import type { CaptionWord } from "./subtitle-parser.js";
import type { ChatMessage } from "./chat-parser.js";

export type { AudioSignal } from "./audio-analyzer.js";

export interface TranscriptSignal {
  timestampSec: number;
  weight: number;
  phrases: string[];
  text?: string;
  type: "keyword" | "caps" | "sentiment" | "story" | "laugh" | "shock" | "funny_quote";
}

export interface ChatSignal {
  timestampSec: number;
  messageRate: number;
  emojiDensity: number;
  keywordHits: string[];
  spikeIntensity: number;
  /** Number of LOL/LMAO/HAHA-style messages in the bin. */
  laughHits?: number;
  /** Number of WTF/OMG/no-way/gasp-style messages in the bin. */
  shockHits?: number;
  /** Reaction keywords divided by message count; used to separate real eruptions from raw chat volume. */
  reactionDensity?: number;
  reactionType?: "laugh" | "shock" | "mixed" | "generic";
}

const KEYWORD_WEIGHTS: { weight: number; phrases: string[] }[] = [
  // Tier 1: Unmistakable peak reactions — works for comedy, skill, AND crash-outs
  {
    weight: 0.9,
    phrases: [
      "no way",
      "what the",
      "oh my god",
      "clip that",
      "i'm done",
      "are you kidding",
      "holy shit",
      "what the fuck",
      "bro what",
      "did you see that",
      "how did you",
      "he's cracked",
      // Peanut catchphrases (streamer-specific signals)
      "lock in",           // says this before/during highlights
      "hooray",            // celebration after something cool
      // Crash-out peaks
      "i'm leaving",
      "i'm getting off",
      "turn this off",
      "i quit",
    ],
  },
  // Tier 2: Strong reactions — comedy, gameplay hype, and tilt
  {
    weight: 0.7,
    phrases: [
      // General reactions
      // "dude" is intentionally not a standalone signal: Peanut says it in
      // normal conversation constantly, so it should only matter via another
      // stronger phrase in the same window.
      "holy",
      "insane",
      "let's go",
      "oh no",
      "bruh",
      // Skill/gameplay hype
      "clutch",
      "nice shot",
      "that was nasty",
      "he's frying",
      "you're frying",
      "he just",
      "one shot",
      "that was disgusting",
      "he's a demon",
      "you're a demon",
      "goated",

      // Crash-out / tilt
      "this game is",
      "are you serious",
      "every single time",
      "i hate this",
      "i can't",
      "bro stop",
      "how is that",
      "that's bullshit",
    ],
  },
  // Tier 3: Comedy-specific
  {
    weight: 0.8,
    phrases: [
      "i'm crying",
      "i can't breathe",
      "i'm dead",
      "you can't say that",
      "that is crazy",
      "that was crazy",
      "what am i watching",
      "absolute cinema",
      "we won gambling",
      "best gamblers",
      "beat the game",
      "help me",
    ],
  },
  {
    weight: 0.7,
    phrases: [
      "haha",
      "hahaha",
      "laughing",
      "i'm laughing",
      "that was funny",
      "that's hilarious",
      "that's so funny",
    ],
  },
  {
    weight: 0.6,
    phrases: ["that's what she said", "deez nuts", "sus", "pause", "my ass", "sweating my balls"],
  },
  // Tier 4: Storytelling markers
  {
    weight: 0.5,
    phrases: [
      "so basically",
      "let me tell you",
      "one time",
      "i swear",
      "no joke",
      "true story",
    ],
  },
  // Tier 5: Gameplay callouts + tilt markers — low weight individually but
  // valuable when clustered with audio/chat signals
  {
    weight: 0.4,
    phrases: [
      // Skill callouts
      "headshot",
      "collateral",
      "triple kill",
      "ace",
      "team wipe",
      "squad wipe",
      "one v",
      "1v",
      "snipe",
      "no scope",
      "cross map",
      "i'm him",
      // Crash-out / frustration markers
      "broken",
      "trash",
      "garbage",
      "dog water",
      "cheating",
      "lagging",
      "this server",
    ],
  },
];

const SHOCK_TRANSCRIPT_PHRASES = new Set([
  "no way",
  "what the",
  "oh my god",
  "are you kidding",
  "holy shit",
  "what the fuck",
  "bro what",
  "did you see that",
  "oh no",
  "are you serious",
  "i can't",
  "i'm leaving",
  "i'm getting off",
  "turn this off",
  "i quit",
]);

const LAUGH_TRANSCRIPT_PHRASES = new Set([
  "haha",
  "hahaha",
  "laughing",
  "i'm laughing",
  "i'm crying",
  "i can't breathe",
  "i'm dead",
  "that was funny",
  "that's hilarious",
  "that's so funny",
]);

const FUNNY_QUOTE_TRANSCRIPT_PHRASES = new Set([
  "you can't say that",
  "what am i watching",
  "absolute cinema",
  "we won gambling",
  "best gamblers",
  "beat the game",
  "help me",
  "that's what she said",
  "deez nuts",
  "sus",
  "pause",
  "my ass",
  "sweating my balls",
  "hooray",
]);

function transcriptTypeForPhrase(phrase: string, weight: number): TranscriptSignal["type"] {
  if (FUNNY_QUOTE_TRANSCRIPT_PHRASES.has(phrase)) return "funny_quote";
  if (LAUGH_TRANSCRIPT_PHRASES.has(phrase)) return "laugh";
  if (SHOCK_TRANSCRIPT_PHRASES.has(phrase)) return "shock";
  if (weight === 0.5) return "story";
  return "keyword";
}

const CHAT_KEYWORDS = [
  // General reactions
  "clip that",
  "no way",
  "lmao",
  "lmfao",
  "lol",
  "haha",
  "hahaha",
  "hehe",
  "omegalul",
  "kekw",
  "rofl",
  "w",
  "l",
  "gg",
  "bruh",
  "dead",
  // Skill/gameplay hype
  "cracked",
  "frying",
  "nasty",
  "goated",
  "demon",
  "insane",
  "sheesh",
  // Crash-out reactions
  "rage",
  "tilted",
  "mald",
  "malding",
  "salty",
  "rip",
];

const CHAT_LAUGH_RE = /\b(?:l+o+l+|lmao+|lmfao+|rofl|haha+|hehe+|omegalul|kekw|dead|dying|crying)\b/gi;
const CHAT_SHOCK_RE = /\b(?:wtf|omg|no way|bro what|what the|holy|gasp|nah|crazy|insane)\b/gi;

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

const EMOJI_RE =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

const WINDOW_SEC = 10;

const RUNNING_BIT_STOPWORDS = new Set([
  "about", "actually", "after", "again", "behind", "because", "before", "being", "bring", "could", "doing", "first", "going", "gonna", "gotta", "right", "should", "their", "there", "these", "thing", "those", "through", "trying", "where", "which", "would", "youre",
]);

const RUNNING_BIT_SUBJECTS = new Set([
  "wizard", "wizards", "demon", "demons", "robot", "robots", "bugulator", "bugulators", "friend", "friends", "mountain", "massive", "ginormous", "burly", "monster", "monsters", "creature", "creatures", "goblin", "goblins", "alien", "aliens",
]);

function repeatedRunningBitTerm(words: CaptionWord[]): string | null {
  const freq = new Map<string, number>();
  for (const w of words) {
    const token = w.word.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (token.length < 5 || RUNNING_BIT_STOPWORDS.has(token) || !RUNNING_BIT_SUBJECTS.has(token)) continue;
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  for (const [token, count] of freq) {
    if (count >= 3) return token;
  }
  return null;
}

export function detectTranscriptSignals(
  words: CaptionWord[],
): TranscriptSignal[] {
  if (words.length === 0) return [];

  const minSec = words[0].startMs / 1000;
  const maxSec = words[words.length - 1].startMs / 1000;

  const signals: TranscriptSignal[] = [];

  for (
    let windowStart = Math.floor(minSec / WINDOW_SEC) * WINDOW_SEC;
    windowStart <= maxSec;
    windowStart += WINDOW_SEC
  ) {
    const windowEnd = windowStart + WINDOW_SEC;
    const windowWords = words.filter((w) => {
      const sec = w.startMs / 1000;
      return sec >= windowStart && sec < windowEnd;
    });

    if (windowWords.length === 0) continue;

    const joined = windowWords.map((w) => w.word).join(" ").toLowerCase();
    const matched: { weight: number; phrase: string; type: TranscriptSignal["type"] }[] = [];

    for (const group of KEYWORD_WEIGHTS) {
      for (const phrase of group.phrases) {
        if (joined.includes(phrase)) {
          matched.push({
            weight: group.weight,
            phrase,
            type: transcriptTypeForPhrase(phrase, group.weight),
          });
        }
      }
    }

    // Caps detection
    const capsCount = windowWords.filter(
      (w) => w.word.length > 1 && w.word === w.word.toUpperCase() && /[A-Z]/.test(w.word),
    ).length;
    if (capsCount > 3) {
      matched.push({ weight: 0.6, phrase: "ALL_CAPS", type: "caps" });
    }

    // Sentiment detection: short exclamations or repeated words
    const exclamations = windowWords.filter(
      (w) => w.word.length <= 4 && /^[a-zA-Z]+$/.test(w.word),
    );
    const wordFreq = new Map<string, number>();
    for (const w of exclamations) {
      const lower = w.word.toLowerCase();
      wordFreq.set(lower, (wordFreq.get(lower) ?? 0) + 1);
    }
    const hasRepeats = [...wordFreq.values()].some((c) => c >= 3);
    if (hasRepeats || exclamations.length > 6) {
      matched.push({ weight: 0.5, phrase: "exclamations", type: "sentiment" });
    }

    // ponytail: captures wizard/burly-men/robot style bits without game-specific code.
    const runningBit = repeatedRunningBitTerm(windowWords);
    if (runningBit) {
      matched.push({ weight: 0.75, phrase: `running-bit:${runningBit}`, type: "story" });
    }

    if (matched.length === 0) continue;

    // Require keyword clusters: need 2+ distinct keyword/sentiment hits
    // to filter out constant gaming chatter ("dude", "oh no" said every 10s)
    const distinctPhrases = new Set(matched.map((m) => m.phrase));
    const hasStrongHit = matched.some((m) => m.weight >= 0.9);
    const hasHumorHit = matched.some((m) => m.type === "laugh" || m.type === "funny_quote");
    const hasRunningBit = matched.some((m) => m.phrase.startsWith("running-bit:"));

    // Pass if: 2+ distinct phrases, one unmistakable shock phrase, or one explicit laugh/funny-quote phrase.
    if (distinctPhrases.size < 2 && !hasStrongHit && !hasHumorHit && !hasRunningBit) continue;

    // Boost weight when multiple signals cluster together
    const best = matched.reduce((a, b) => (b.weight > a.weight ? b : a));
    const clusterBonus = Math.min((distinctPhrases.size - 1) * 0.1, 0.2);

    signals.push({
      timestampSec: windowStart + WINDOW_SEC / 2,
      weight: Math.min(best.weight + clusterBonus, 1.0),
      phrases: matched.map((m) => m.phrase),
      text: joined,
      type: best.type,
    });
  }

  return signals.sort((a, b) => a.timestampSec - b.timestampSec);
}

export function detectChatSignals(
  messages: ChatMessage[],
  binSizeSec = 2,
): ChatSignal[] {
  if (messages.length === 0) return [];

  const minSec = Math.min(...messages.map((m) => m.timestampSec));
  const maxSec = Math.max(...messages.map((m) => m.timestampSec));

  const bins = new Map<
    number,
    { count: number; emojiChars: number; totalChars: number; texts: string[]; laughHits: number; shockHits: number }
  >();

  for (
    let start = Math.floor(minSec / binSizeSec) * binSizeSec;
    start <= maxSec;
    start += binSizeSec
  ) {
    bins.set(start, { count: 0, emojiChars: 0, totalChars: 0, texts: [], laughHits: 0, shockHits: 0 });
  }

  for (const msg of messages) {
    const binStart =
      Math.floor(msg.timestampSec / binSizeSec) * binSizeSec;
    let bin = bins.get(binStart);
    if (!bin) {
      bin = { count: 0, emojiChars: 0, totalChars: 0, texts: [], laughHits: 0, shockHits: 0 };
      bins.set(binStart, bin);
    }
    bin.count++;
    const emojis = msg.text.match(EMOJI_RE);
    bin.emojiChars += emojis ? emojis.length : 0;
    bin.totalChars += msg.text.length;
    const lowerText = msg.text.toLowerCase();
    bin.texts.push(lowerText);
    bin.laughHits += countMatches(lowerText, CHAT_LAUGH_RE);
    bin.shockHits += countMatches(lowerText, CHAT_SHOCK_RE);
  }

  const rates: { binStart: number; rate: number }[] = [];
  for (const [binStart, bin] of bins) {
    rates.push({ binStart, rate: bin.count / binSizeSec });
  }

  const mean =
    rates.reduce((sum, r) => sum + r.rate, 0) / (rates.length || 1);
  const variance =
    rates.reduce((sum, r) => sum + (r.rate - mean) ** 2, 0) /
    (rates.length || 1);
  const stddev = Math.sqrt(variance);

  const signals: ChatSignal[] = [];

  for (const { binStart, rate } of rates) {
    const intensity = stddev > 0 ? (rate - mean) / stddev : 0;

    const bin = bins.get(binStart)!;
    const joined = bin.texts.join(" ");

    const keywordHits: string[] = [];
    for (const kw of CHAT_KEYWORDS) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      const matches = joined.match(re);
      if (matches && matches.length > 0) {
        keywordHits.push(kw);
      }
    }

    const reactionHits = bin.laughHits + bin.shockHits + keywordHits.length;
    const reactionDensity = bin.count > 0 ? reactionHits / bin.count : 0;
    const isEruption = intensity > 1.5 || bin.laughHits >= 2 || bin.shockHits >= 2 || reactionDensity >= 0.6;
    if (!isEruption) continue;

    let reactionType: ChatSignal["reactionType"] = "generic";
    if (bin.laughHits > 0 && bin.shockHits > 0) reactionType = "mixed";
    else if (bin.laughHits > 0) reactionType = "laugh";
    else if (bin.shockHits > 0) reactionType = "shock";

    signals.push({
      timestampSec: binStart + binSizeSec / 2,
      messageRate: rate,
      emojiDensity: bin.totalChars > 0 ? bin.emojiChars / bin.totalChars : 0,
      keywordHits,
      spikeIntensity: intensity,
      laughHits: bin.laughHits,
      shockHits: bin.shockHits,
      reactionDensity,
      reactionType,
    });
  }

  return signals.sort((a, b) => a.timestampSec - b.timestampSec);
}
