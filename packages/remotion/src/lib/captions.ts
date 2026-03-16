export interface CaptionWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface CaptionGroup {
  words: CaptionWord[];
  startMs: number;
  endMs: number;
  text: string;
}

export function groupCaptions(
  words: CaptionWord[],
  wordsPerGroup: number = 6
): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  for (let i = 0; i < words.length; i += wordsPerGroup) {
    const groupWords = words.slice(i, i + wordsPerGroup);
    groups.push({
      words: groupWords,
      startMs: groupWords[0].startMs,
      endMs: groupWords[groupWords.length - 1].endMs,
      text: groupWords.map((w) => w.word).join(" "),
    });
  }
  return groups;
}

export function getCurrentCaptionGroup(
  groups: CaptionGroup[],
  currentMs: number
): CaptionGroup | null {
  return (
    groups.find((g) => currentMs >= g.startMs && currentMs <= g.endMs) ?? null
  );
}

export function getActiveWordIndex(
  group: CaptionGroup,
  currentMs: number
): number {
  for (let i = group.words.length - 1; i >= 0; i--) {
    if (currentMs >= group.words[i].startMs) return i;
  }
  return 0;
}
