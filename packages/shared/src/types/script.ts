export interface ScriptSection {
  id: string;
  heading: string;
  narration: string;
  visualNotes: string;
  durationEstimateSec: number;
  formulaAct?: "hook" | "setup" | "turn" | "payoff" | "sting";
  chapter?: string;
}

export interface ScriptPackage {
  hookText: string;
  sections: ScriptSection[];
  fullNarration: string;
  youtubeTitle: string;
  youtubeDescription: string;
  youtubeTags: string[];
  tiktokCaption?: string;
  instagramCaption?: string;
  playerName?: string;
  seriesFormat?: string;
  pinnedComment?: string;
}
