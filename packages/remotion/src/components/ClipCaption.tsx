import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig, spring } from "remotion";
import type { CaptionWord } from "../lib/captions";
import {
  groupCaptions,
  getCurrentCaptionGroup,
  getActiveWordIndex,
} from "../lib/captions";

interface ClipCaptionProps {
  words: CaptionWord[];
  wordsPerGroup?: number;
  yPosition?: number;
  position?: "absolute-y" | "bottom";
  bottomOffset?: number;
}

export const ClipCaption: React.FC<ClipCaptionProps> = ({
  words,
  wordsPerGroup = 3,
  yPosition = 740,
  position = "absolute-y",
  bottomOffset = 200,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;

  const groups = useMemo(
    () => groupCaptions(words, wordsPerGroup),
    [words, wordsPerGroup]
  );
  const activeGroup = getCurrentCaptionGroup(groups, currentMs);

  if (!activeGroup) return null;

  const activeIdx = getActiveWordIndex(activeGroup, currentMs);

  const groupStartFrame = Math.round((activeGroup.startMs / 1000) * fps);
  const relFrame = frame - groupStartFrame;
  const pop = spring({
    frame: Math.max(0, relFrame),
    fps,
    config: { damping: 10, mass: 0.4, stiffness: 200 },
  });

  const positionStyle: React.CSSProperties =
    position === "absolute-y"
      ? { position: "absolute", top: yPosition, left: 0, right: 0 }
      : { position: "absolute", bottom: bottomOffset, left: 0, right: 0 };

  return (
    <div
      style={{
        ...positionStyle,
        transform: `scale(${0.85 + pop * 0.15})`,
        display: "flex",
        justifyContent: "center",
        opacity: pop,
      }}
    >
      <div
        style={{
          padding: "12px 24px",
          maxWidth: "85%",
          textAlign: "center",
          backgroundColor: "rgba(0,0,0,0.65)",
          borderRadius: 12,
        }}
      >
        {activeGroup.words.map((w, i) => {
          const isActive = i === activeIdx;
          const hasPunctuation = /[.,!?;:]$/.test(w.word);
          return (
            <React.Fragment key={`${w.startMs}-${i}`}>
              <span
                style={{
                  fontFamily: '"Inter", sans-serif',
                  fontSize: 44,
                  fontWeight: 700,
                  color: isActive ? "#fbbf24" : "#f5f5f0",
                  textShadow: isActive
                    ? "0 0 16px rgba(251,191,36,0.5), 0 2px 8px rgba(0,0,0,0.9)"
                    : "0 2px 8px rgba(0,0,0,0.9)",
                  letterSpacing: 0.5,
                }}
              >
                {w.word}
              </span>
              <span style={{ fontSize: 44, letterSpacing: 0.5 }}>
                {hasPunctuation ? "\u00A0\u00A0" : "\u00A0"}
              </span>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
