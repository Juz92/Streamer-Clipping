import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import type { GamingShortProps } from "./schema";
import { ClipCaption } from "../../components/ClipCaption";

const SRC_W = 1920;
const SRC_H = 1080;

const PANEL_W = 1080;
const AVATAR_H = 768;
const GAMEPLAY_H = 1152;
const DIVIDER_Y = 766;
const DIVIDER_H = 4;

function regionCropStyle(
  region: { x: number; y: number; w: number; h: number },
  panelW: number,
  panelH: number
): React.CSSProperties {
  const scaleX = panelW / region.w;
  const scaleY = panelH / region.h;
  const scale = Math.max(scaleX, scaleY);
  const scaledW = SRC_W * scale;
  const scaledH = SRC_H * scale;
  const offsetX = -(region.x * scale) + (panelW - region.w * scale) / 2;
  const offsetY = -(region.y * scale) + (panelH - region.h * scale) / 2;

  return {
    position: "absolute" as const,
    width: scaledW,
    height: scaledH,
    left: offsetX,
    top: offsetY,
  };
}

export const GamingShort: React.FC<GamingShortProps> = ({
  clipSrc,
  layoutMode,
  avatarRegion,
  gameplayRegion,
  captionWords,
  title,
}) => {
  const resolvedSrc = staticFile(clipSrc);

  if (layoutMode === "gameplay" && gameplayRegion) {
    return (
      <AbsoluteFill style={{ backgroundColor: "#0a0a0a" }}>
        {/* Avatar panel -- top 40% */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: PANEL_W,
            height: AVATAR_H,
            overflow: "hidden",
          }}
        >
          <OffthreadVideo
            src={resolvedSrc}
            style={regionCropStyle(avatarRegion, PANEL_W, AVATAR_H)}
          />
        </div>

        {/* Divider */}
        <div
          style={{
            position: "absolute",
            top: DIVIDER_Y,
            left: 0,
            right: 0,
            height: DIVIDER_H,
            backgroundColor: "rgba(255,255,255,0.15)",
          }}
        />

        {/* Gameplay panel -- bottom 60% */}
        <div
          style={{
            position: "absolute",
            top: AVATAR_H,
            left: 0,
            width: PANEL_W,
            height: GAMEPLAY_H,
            overflow: "hidden",
          }}
        >
          <OffthreadVideo
            src={resolvedSrc}
            style={regionCropStyle(gameplayRegion, PANEL_W, GAMEPLAY_H)}
          />
        </div>

        {/* Captions between panels */}
        {captionWords && captionWords.length > 0 && (
          <ClipCaption words={captionWords} yPosition={700} position="absolute-y" />
        )}
      </AbsoluteFill>
    );
  }

  // Talking mode (or gameplay without gameplayRegion fallback)
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0a0a" }}>
      {/* Blurred background fill */}
      <OffthreadVideo
        src={resolvedSrc}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          filter: "blur(20px) brightness(0.3)",
          transform: "scale(1.1)",
        }}
      />

      {/* Sharp video centered */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: PANEL_W,
          height: 1920,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <OffthreadVideo
          src={resolvedSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            transform: "scale(1.5)",
          }}
        />
      </div>

      {/* Captions -- bottom third */}
      {captionWords && captionWords.length > 0 && (
        <ClipCaption words={captionWords} position="bottom" bottomOffset={200} />
      )}
    </AbsoluteFill>
  );
};

export default GamingShort;
