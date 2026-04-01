import React from "react";
import { AbsoluteFill } from "remotion";
import { theme } from "../../../styles/theme";

interface BoldThumbnailProps {
  title: string;
  accentColor: string;
}

export const BoldThumbnail: React.FC<BoldThumbnailProps> = ({
  title,
  accentColor,
}) => {
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${theme.colors.bg} 0%, #1a1a2e 50%, ${accentColor}33 100%)`,
        justifyContent: "center",
        alignItems: "center",
        padding: "48px 64px",
      }}
    >
      <h1
        style={{
          fontFamily: theme.fonts.heading,
          fontSize: 80,
          fontWeight: 900,
          color: theme.colors.text,
          lineHeight: 1.1,
          textAlign: "center",
          textShadow: `0 0 60px ${accentColor}66`,
        }}
      >
        {title}
      </h1>
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 6,
          backgroundColor: accentColor,
        }}
      />
    </AbsoluteFill>
  );
};
