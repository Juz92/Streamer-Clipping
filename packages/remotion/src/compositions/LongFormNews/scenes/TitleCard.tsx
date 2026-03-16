import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
} from "remotion";
import { theme } from "../../../styles/theme";

interface TitleCardProps {
  title: string;
  subtitle?: string;
}

export const TitleCard: React.FC<TitleCardProps> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleY = spring({ frame, fps, config: { damping: 15, mass: 0.8 } });
  const accentWidth = interpolate(frame, [10, 30], [0, 400], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const subtitleOpacity = interpolate(frame, [20, 35], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.bg,
        justifyContent: "center",
        alignItems: "center",
        padding: theme.spacing.xxl,
      }}
    >
      <div
        style={{
          transform: `translateY(${(1 - titleY) * 40}px)`,
          opacity: titleY,
          textAlign: "center",
        }}
      >
        <h1
          style={{
            fontFamily: theme.fonts.heading,
            fontSize: theme.fontSizes.title,
            fontWeight: 800,
            color: theme.colors.text,
            margin: 0,
            lineHeight: 1.1,
          }}
        >
          {title}
        </h1>

        <div
          style={{
            width: accentWidth,
            height: 4,
            backgroundColor: theme.colors.accent,
            margin: "24px auto",
            borderRadius: 2,
            boxShadow: `0 0 20px ${theme.colors.accentGlow}`,
          }}
        />

        {subtitle && (
          <p
            style={{
              fontFamily: theme.fonts.body,
              fontSize: theme.fontSizes.subheading,
              color: theme.colors.textSecondary,
              margin: 0,
              opacity: subtitleOpacity,
            }}
          >
            {subtitle}
          </p>
        )}
      </div>
    </AbsoluteFill>
  );
};
