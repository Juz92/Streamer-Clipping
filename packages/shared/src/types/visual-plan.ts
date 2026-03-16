export interface ShotPlan {
  id: string;
  sectionId: string;
  type: "screenshot" | "browser_recording" | "text_card";
  url?: string;
  selector?: string;
  scrollTo?: string;
  clickSequence?: string[];
  durationMs: number;
  caption?: string;
  textContent?: string;
  kenBurns?: {
    startScale: number;
    endScale: number;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  };
}
