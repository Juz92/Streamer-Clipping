import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { theme } from "../../../styles/theme";

interface MinimalThumbnailProps {
  title: string;
  backgroundSrc?: string;
  accentColor: string;
}

export const MinimalThumbnail: React.FC<MinimalThumbnailProps> = ({
  title,
  backgroundSrc,
  accentColor,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
      {backgroundSrc && (
        <Img
          src={backgroundSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            opacity: 0.15,
          }}
        />
      )}
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          padding: "48px 64px",
        }}
      >
        <div
          style={{
            borderLeft: `4px solid ${accentColor}`,
            paddingLeft: 24,
          }}
        >
          <h1
            style={{
              fontFamily: theme.fonts.heading,
              fontSize: 56,
              fontWeight: 700,
              color: theme.colors.text,
              lineHeight: 1.2,
              margin: 0,
            }}
          >
            {title}
          </h1>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
