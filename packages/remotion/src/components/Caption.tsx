import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { theme } from "../styles/theme";
import type { CaptionWord } from "../lib/captions";
import {
  groupCaptions,
  getCurrentCaptionGroup,
  getActiveWordIndex,
} from "../lib/captions";

interface CaptionProps {
  words: CaptionWord[];
  wordsPerGroup?: number;
}

export const Caption: React.FC<CaptionProps> = ({
  words,
  wordsPerGroup = 6,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;

  const groups = groupCaptions(words, wordsPerGroup);
  const activeGroup = getCurrentCaptionGroup(groups, currentMs);

  if (!activeGroup) return null;

  const activeIdx = getActiveWordIndex(activeGroup, currentMs);
  const fadeIn = interpolate(
    currentMs,
    [activeGroup.startMs - 100, activeGroup.startMs],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <div
      style={{
        position: "absolute",
        bottom: 80,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        opacity: fadeIn,
      }}
    >
      <div
        style={{
          backgroundColor: theme.colors.captionBg,
          padding: "12px 24px",
          borderRadius: 8,
          maxWidth: "80%",
        }}
      >
        <span
          style={{
            fontFamily: theme.fonts.body,
            fontSize: theme.fontSizes.caption,
            lineHeight: 1.4,
          }}
        >
          {activeGroup.words.map((w, i) => (
            <span
              key={`${w.startMs}-${i}`}
              style={{
                color:
                  i <= activeIdx
                    ? theme.colors.captionHighlight
                    : theme.colors.text,
                fontWeight: i === activeIdx ? 700 : 400,
              }}
            >
              {w.word}{" "}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
};
