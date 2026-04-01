export interface ShotPlan {
  id: string;
  sectionId: string;
  type: "still_image" | "text_card" | "split_view" | "ai_video" | "timeline" | "badge_reveal";
  durationMs: number;
  caption?: string;
  source?: string;
  textContent?: string;
  transition?:
    | "none"
    | "fade"
    | "wipe-left"
    | "wipe-right"
    | "wipe-up"
    | "wipe-down"
    | "zoom-punch";
  kenBurns?: {
    startScale?: number;
    endScale?: number;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
    preset?: string;
  };
  // still_image specific
  imageSrc?: string;
  imageAttribution?: string;
  // ai_video specific
  imagePrompt?: string;
  animationPrompt?: string;
  // split_view specific
  leftAssetId?: string;
  rightAssetId?: string;
  leftLabel?: string;
  rightLabel?: string;
  // map specific
  mapCenter?: { lat: number; lng: number };
  mapMarkers?: { lat: number; lng: number; label?: string }[];
  mapRoute?: { lat: number; lng: number }[];
  // timeline specific
  timelineEvents?: { year: string; label: string; highlight?: boolean }[];
  // badge_reveal specific
  badgeSrc?: string;
  clubName?: string;
  // highlight clip background for text_card scenes
  backgroundClip?: string;
  /** B-roll source for ai_video shots (set by b-roll.ts --register) */
  src?: string;
  // chapter grouping for long-form videos
  chapter?: string;
}
