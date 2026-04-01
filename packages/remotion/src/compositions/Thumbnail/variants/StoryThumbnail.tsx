import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { theme } from "../../../styles/theme";

interface StoryThumbnailProps {
  title: string;
  playerImageSrc?: string;
  seriesBadge?: string;
  accentColor?: string;
}

export const StoryThumbnail: React.FC<StoryThumbnailProps> = ({
  title,
  playerImageSrc,
  seriesBadge,
  accentColor = theme.colors.accent,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
      {/* Player portrait — left 40% */}
      {playerImageSrc && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: "40%",
            overflow: "hidden",
          }}
        >
          <Img
            src={staticFile(playerImageSrc)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center top",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "linear-gradient(to right, transparent 60%, #0a0a0a 100%)",
            }}
          />
        </div>
      )}

      {/* Gold stripe divider */}
      <div
        style={{
          position: "absolute",
          left: playerImageSrc ? "38%" : 0,
          top: 0,
          bottom: 0,
          width: 6,
          backgroundColor: accentColor,
        }}
      />

      {/* Title text — right 60% */}
      <div
        style={{
          position: "absolute",
          left: playerImageSrc ? "42%" : "8%",
          top: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "48px 48px 48px 24px",
        }}
      >
        <h1
          style={{
            fontFamily: theme.fonts.heading,
            fontSize: 56,
            fontWeight: 700,
            color: theme.colors.text,
            lineHeight: 1.15,
            margin: 0,
            textTransform: "uppercase",
            textShadow: "0 2px 20px rgba(0,0,0,0.8)",
          }}
        >
          {title}
        </h1>
      </div>

      {/* Series badge — top-right */}
      {seriesBadge && (
        <div
          style={{
            position: "absolute",
            top: 20,
            right: 20,
            backgroundColor: "rgba(0,0,0,0.7)",
            border: `2px solid ${accentColor}`,
            borderRadius: 8,
            padding: "6px 14px",
          }}
        >
          <span
            style={{
              fontFamily: theme.fonts.body,
              fontSize: 16,
              color: accentColor,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            {seriesBadge}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
};
