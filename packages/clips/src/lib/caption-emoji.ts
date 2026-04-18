/**
 * caption-emoji.ts — contextual emoji insertion for caption chunks.
 *
 * The OpusClip-style polish move: a single emoji appended to a caption
 * chunk that lands on a tier-1 keyword. One or two per clip — any more
 * and it reads like an ad overlay, not comedy.
 *
 * Pure function, no ffmpeg, no file I/O.
 *
 * NOTE ON FONTS: emoji glyphs only render in the baked ASS output if the
 * chosen fontname has colour-emoji coverage. On Windows that means
 * "Segoe UI" (which has fallback into Segoe UI Emoji) — "Arial" will
 * produce tofu boxes. Callers that enable emojis should also pass the
 * matching fontname to writeKaraokeAss.
 */

export interface CaptionWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface CaptionChunk {
  startMs: number;
  endMs: number;
  words: CaptionWord[];
}

export const CAPTION_EMOJI_FONT = "Segoe UI";

/**
 * Keyword → emoji. Phrases must be lowercased. Longer phrases win over
 * shorter ones when multiple would match the same chunk.
 */
const EMOJI_MAP: Array<{ phrase: string; emoji: string }> = [
  { phrase: "oh my god", emoji: "😱" },
  { phrase: "clip that", emoji: "✂️" },
  { phrase: "what the", emoji: "😳" },
  { phrase: "no way", emoji: "🤯" },
  { phrase: "holy", emoji: "🤯" },
  { phrase: "insane", emoji: "🤯" },
  { phrase: "lock in", emoji: "🔒" },
  { phrase: "hooray", emoji: "🎉" },
  { phrase: "dead", emoji: "💀" },
  { phrase: "dude", emoji: "😂" },
  { phrase: "bruh", emoji: "😂" },
];

function normalizeText(chunk: CaptionChunk): string {
  return chunk.words
    .map((w) => w.word.toLowerCase().replace(/[^\w\s]/g, ""))
    .join(" ");
}

/**
 * Append an emoji to the last word of any chunk whose combined text contains
 * a phrase from EMOJI_MAP. Caps total emojis per clip so output doesn't read
 * like a teen's Instagram bio.
 */
export function insertEmojis(
  chunks: CaptionChunk[],
  maxPerClip = 2,
): CaptionChunk[] {
  if (chunks.length === 0 || maxPerClip <= 0) return chunks;

  let remaining = maxPerClip;
  const result: CaptionChunk[] = [];

  for (const chunk of chunks) {
    if (remaining <= 0) {
      result.push(chunk);
      continue;
    }
    const text = ` ${normalizeText(chunk)} `;
    // Longest phrases first so "oh my god" wins over "god".
    const match = [...EMOJI_MAP]
      .sort((a, b) => b.phrase.length - a.phrase.length)
      .find((entry) => text.includes(` ${entry.phrase} `) || text.includes(entry.phrase));

    if (match) {
      const newWords = chunk.words.map((w, idx) => {
        if (idx !== chunk.words.length - 1) return w;
        return { ...w, word: `${w.word} ${match.emoji}` };
      });
      result.push({ ...chunk, words: newWords });
      remaining--;
    } else {
      result.push(chunk);
    }
  }

  return result;
}
