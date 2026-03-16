import React from "react";
import { AbsoluteFill } from "remotion";
import { KenBurns } from "../../../components/KenBurns";
import { theme } from "../../../styles/theme";

interface ScreenshotProps {
  src: string;
  caption?: string;
  kenBurns?: {
    startScale?: number;
    endScale?: number;
    startX?: number;
    startY?: number;
    endX?: number;
    endY?: number;
  };
}

export const Screenshot: React.FC<ScreenshotProps> = ({
  src,
  caption,
  kenBurns,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
      <KenBurns src={src} {...kenBurns} />
      {caption && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            padding: "16px 24px",
            background:
              "linear-gradient(transparent, rgba(0,0,0,0.8))",
          }}
        >
          <span
            style={{
              fontFamily: theme.fonts.body,
              fontSize: theme.fontSizes.small,
              color: theme.colors.textSecondary,
            }}
          >
            {caption}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};
