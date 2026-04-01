import type { CaptionWord } from "./subtitle-parser.js";
import type { ChatMessage } from "./chat-parser.js";

export type { AudioSignal } from "./audio-analyzer.js";

export interface TranscriptSignal {
  timestampSec: number;
  weight: number;
  phrases: string[];
  type: "keyword" | "caps" | "sentiment" | "story";
}

export interface ChatSignal {
  timestampSec: number;
  messageRate: number;
  emojiDensity: number;
  keywordHits: string[];
  spikeIntensity: number;
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
      "dude",
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
      "absolutely",
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
    weight: 0.6,
    phrases: ["that's what she said", "deez nuts", "sus", "pause"],
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

const WEIGHT_TO_TYPE: Record<number, TranscriptSignal["type"]> = {
  0.9: "keyword",
  0.7: "keyword",
  0.6: "keyword",
  0.5: "story",
  0.4: "keyword",
};

const CHAT_KEYWORDS = [
  // General reactions
  "clip that",
  "no way",
  "lmao",
  "lol",
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

const EMOJI_RE =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

const WINDOW_SEC = 10;

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
            type: WEIGHT_TO_TYPE[group.weight] ?? "keyword",
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

    if (matched.length === 0) continue;

    // Require keyword clusters: need 2+ distinct keyword/sentiment hits
    // to filter out constant gaming chatter ("dude", "oh no" said every 10s)
    const distinctPhrases = new Set(matched.map((m) => m.phrase));
    const keywordHits = matched.filter((m) => m.type === "keyword" || m.type === "story");
    const hasStrongHit = matched.some((m) => m.weight >= 0.9);

    // Pass if: 2+ distinct phrases, OR one 0.9-weight hit with caps/sentiment backup
    if (distinctPhrases.size < 2 && !hasStrongHit) continue;

    // Boost weight when multiple signals cluster together
    const best = matched.reduce((a, b) => (b.weight > a.weight ? b : a));
    const clusterBonus = Math.min((distinctPhrases.size - 1) * 0.1, 0.2);

    signals.push({
      timestampSec: windowStart + WINDOW_SEC / 2,
      weight: Math.min(best.weight + clusterBonus, 1.0),
      phrases: matched.map((m) => m.phrase),
      type: best.type,
    });
  }

  return signals.sort((a, b) => a.timestampSec - b.timestampSec);
}

export function detectChatSignals(
  messages: ChatMessage[],
  binSizeSec = 10,
): ChatSignal[] {
  if (messages.length === 0) return [];

  const minSec = Math.min(...messages.map((m) => m.timestampSec));
  const maxSec = Math.max(...messages.map((m) => m.timestampSec));

  const bins = new Map<
    number,
    { count: number; emojiChars: number; totalChars: number; texts: string[] }
  >();

  for (
    let start = Math.floor(minSec / binSizeSec) * binSizeSec;
    start <= maxSec;
    start += binSizeSec
  ) {
    bins.set(start, { count: 0, emojiChars: 0, totalChars: 0, texts: [] });
  }

  for (const msg of messages) {
    const binStart =
      Math.floor(msg.timestampSec / binSizeSec) * binSizeSec;
    let bin = bins.get(binStart);
    if (!bin) {
      bin = { count: 0, emojiChars: 0, totalChars: 0, texts: [] };
      bins.set(binStart, bin);
    }
    bin.count++;
    const emojis = msg.text.match(EMOJI_RE);
    bin.emojiChars += emojis ? emojis.length : 0;
    bin.totalChars += msg.text.length;
    bin.texts.push(msg.text.toLowerCase());
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
    if (stddev === 0) continue;

    const intensity = (rate - mean) / stddev;
    if (intensity <= 1.5) continue;

    const bin = bins.get(binStart)!;
    const joined = bin.texts.join(" ");

    const keywordHits: string[] = [];
    for (const kw of CHAT_KEYWORDS) {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      const matches = joined.match(re);
      if (matches && matches.length > 2) {
        keywordHits.push(kw);
      }
    }

    signals.push({
      timestampSec: binStart + binSizeSec / 2,
      messageRate: rate,
      emojiDensity: bin.totalChars > 0 ? bin.emojiChars / bin.totalChars : 0,
      keywordHits,
      spikeIntensity: intensity,
    });
  }

  return signals.sort((a, b) => a.timestampSec - b.timestampSec);
}
