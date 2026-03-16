export interface ScriptSection {
  id: string;
  heading: string;
  narration: string;
  visualNotes: string;
  durationEstimateSec: number;
}

export interface ScriptPackage {
  hookText: string;
  sections: ScriptSection[];
  fullNarration: string;
  youtubeTitle: string;
  youtubeDescription: string;
  youtubeTags: string[];
}
