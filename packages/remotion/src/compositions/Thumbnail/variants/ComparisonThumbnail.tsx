import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { theme } from "../../../styles/theme";

interface ComparisonThumbnailProps {
  title: string;
  leftSrc?: string;
  rightSrc?: string;
  leftLabel?: string;
  rightLabel?: string;
  accentColor: string;
}

export const ComparisonThumbnail: React.FC<ComparisonThumbnailProps> = ({
  title,
  leftSrc,
  rightSrc,
  leftLabel,
  rightLabel,
  accentColor,
}) => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
      <div style={{ display: "flex", width: "100%", height: "100%" }}>
        {/* Left half */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {leftSrc && (
            <Img
              src={leftSrc}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: 0.6,
              }}
            />
          )}
          {leftLabel && (
            <div
              style={{
                position: "absolute",
                bottom: 80,
                left: 20,
                backgroundColor: "rgba(0,0,0,0.7)",
                padding: "8px 16px",
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  fontFamily: theme.fonts.heading,
                  fontSize: 28,
                  fontWeight: 700,
                  color: theme.colors.text,
                }}
              >
                {leftLabel}
              </span>
            </div>
          )}
        </div>

        {/* VS divider */}
        <div
          style={{
            width: 60,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: accentColor,
            zIndex: 1,
          }}
        >
          <span
            style={{
              fontFamily: theme.fonts.heading,
              fontSize: 28,
              fontWeight: 900,
              color: "#ffffff",
              transform: "rotate(-90deg)",
            }}
          >
            VS
          </span>
        </div>

        {/* Right half */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {rightSrc && (
            <Img
              src={rightSrc}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                opacity: 0.6,
              }}
            />
          )}
          {rightLabel && (
            <div
              style={{
                position: "absolute",
                bottom: 80,
                right: 20,
                backgroundColor: "rgba(0,0,0,0.7)",
                padding: "8px 16px",
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  fontFamily: theme.fonts.heading,
                  fontSize: 28,
                  fontWeight: 700,
                  color: theme.colors.text,
                }}
              >
                {rightLabel}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Title overlay */}
      <div
        style={{
          position: "absolute",
          top: 24,
          left: 0,
          right: 0,
          textAlign: "center",
        }}
      >
        <h1
          style={{
            fontFamily: theme.fonts.heading,
            fontSize: 48,
            fontWeight: 900,
            color: theme.colors.text,
            textShadow: "0 2px 20px rgba(0,0,0,0.9)",
          }}
        >
          {title}
        </h1>
      </div>
    </AbsoluteFill>
  );
};
