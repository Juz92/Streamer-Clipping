import React from "react";
import { AbsoluteFill, Img } from "remotion";
import type { ThumbnailProps } from "./schema";
import { theme } from "../../styles/theme";

export const Thumbnail: React.FC<ThumbnailProps> = ({
  title,
  backgroundSrc,
  accentColor = theme.colors.accent,
}) => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.bg,
      }}
    >
      {backgroundSrc && (
        <Img
          src={backgroundSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: 0.3,
            filter: "blur(2px)",
          }}
        />
      )}

      <AbsoluteFill
        style={{
          background: `linear-gradient(135deg, rgba(0,0,0,0.8) 0%, transparent 60%)`,
        }}
      />

      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 8,
          backgroundColor: accentColor,
        }}
      />

      <AbsoluteFill
        style={{
          justifyContent: "center",
          padding: "48px 64px",
        }}
      >
        <h1
          style={{
            fontFamily: theme.fonts.heading,
            fontSize: theme.fontSizes.thumbnailTitle,
            fontWeight: 900,
            color: theme.colors.text,
            lineHeight: 1.15,
            margin: 0,
            textShadow: "0 2px 20px rgba(0,0,0,0.8)",
            maxWidth: "90%",
          }}
        >
          {title}
        </h1>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
