import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import { theme } from "../../../styles/theme";

export const CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const bounce = spring({
    frame,
    fps,
    config: { damping: 10, mass: 0.6 },
  });

  const pulse = interpolate(
    Math.sin(frame * 0.15),
    [-1, 1],
    [0.95, 1.05]
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          textAlign: "center",
          transform: `scale(${bounce})`,
          opacity: bounce,
        }}
      >
        <h2
          style={{
            fontFamily: theme.fonts.heading,
            fontSize: theme.fontSizes.title,
            fontWeight: 800,
            color: theme.colors.text,
            margin: 0,
            marginBottom: theme.spacing.lg,
          }}
        >
          Like & Subscribe
        </h2>

        <div
          style={{
            display: "flex",
            gap: theme.spacing.lg,
            justifyContent: "center",
          }}
        >
          <div
            style={{
              backgroundColor: "#ff0000",
              padding: "16px 48px",
              borderRadius: 8,
              transform: `scale(${pulse})`,
            }}
          >
            <span
              style={{
                fontFamily: theme.fonts.heading,
                fontSize: theme.fontSizes.subheading,
                fontWeight: 700,
                color: "#ffffff",
              }}
            >
              SUBSCRIBE
            </span>
          </div>

          <div
            style={{
              backgroundColor: theme.colors.bgCard,
              padding: "16px 48px",
              borderRadius: 8,
              border: `2px solid ${theme.colors.accent}`,
            }}
          >
            <span
              style={{
                fontFamily: theme.fonts.heading,
                fontSize: theme.fontSizes.subheading,
                fontWeight: 700,
                color: theme.colors.accent,
              }}
            >
              RING THE BELL
            </span>
          </div>
        </div>

        <p
          style={{
            fontFamily: theme.fonts.body,
            fontSize: theme.fontSizes.body,
            color: theme.colors.textSecondary,
            marginTop: theme.spacing.lg,
          }}
        >
          New AI news videos every day
        </p>
      </div>
    </AbsoluteFill>
  );
};
