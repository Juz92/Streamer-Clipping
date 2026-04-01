import { interFontFamily } from "./fonts";
import { headingFontFamily } from "./fonts";

export const theme = {
  colors: {
    bg: "#0a0a0a",
    bgCard: "#141414",
    accent: "#d4a017",
    accentGlow: "rgba(212, 160, 23, 0.3)",
    secondary: "#1a8f3c",
    text: "#f5f5f0",
    textSecondary: "#a0a0b0",
    textMuted: "#606070",
    captionBg: "rgba(0, 0, 0, 0.75)",
    captionHighlight: "#fbbf24",
    success: "#22c55e",
    warning: "#eab308",
    error: "#ef4444",
  },
  fonts: {
    heading: headingFontFamily,
    body: interFontFamily,
    mono: "'JetBrains Mono', monospace",
  },
  fontSizes: {
    title: 72,
    heading: 48,
    subheading: 36,
    body: 28,
    caption: 56,
    small: 20,
    thumbnailTitle: 64,
    playerName: 80,
    stat: 96,
  },
  spacing: {
    xs: 8,
    sm: 16,
    md: 24,
    lg: 40,
    xl: 64,
    xxl: 96,
  },
} as const;
