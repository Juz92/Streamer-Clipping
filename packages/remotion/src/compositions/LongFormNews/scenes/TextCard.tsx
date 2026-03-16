import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
} from "remotion";
import { theme } from "../../../styles/theme";

interface TextCardProps {
  heading: string;
  body?: string;
}

export const TextCard: React.FC<TextCardProps> = ({ heading, body }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const slideIn = spring({ frame, fps, config: { damping: 14, mass: 0.7 } });

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
          backgroundColor: theme.colors.bgCard,
          borderRadius: 16,
          padding: theme.spacing.xl,
          maxWidth: 1400,
          borderLeft: `4px solid ${theme.colors.accent}`,
          transform: `translateX(${(1 - slideIn) * -60}px)`,
          opacity: slideIn,
        }}
      >
        <h2
          style={{
            fontFamily: theme.fonts.heading,
            fontSize: theme.fontSizes.heading,
            fontWeight: 700,
            color: theme.colors.text,
            margin: 0,
            marginBottom: body ? theme.spacing.md : 0,
          }}
        >
          {heading}
        </h2>
        {body && (
          <p
            style={{
              fontFamily: theme.fonts.body,
              fontSize: theme.fontSizes.body,
              color: theme.colors.textSecondary,
              margin: 0,
              lineHeight: 1.6,
            }}
          >
            {body}
          </p>
        )}
      </div>
    </AbsoluteFill>
  );
};
