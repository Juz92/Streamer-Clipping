import { interFontFamily } from "./fonts";

export const theme = {
  colors: {
    bg: "#0a0a0f",
    bgCard: "#12121a",
    accent: "#6366f1",
    accentGlow: "rgba(99, 102, 241, 0.3)",
    text: "#f0f0f5",
    textSecondary: "#a0a0b0",
    textMuted: "#606070",
    captionBg: "rgba(0, 0, 0, 0.75)",
    captionHighlight: "#818cf8",
    success: "#22c55e",
    warning: "#eab308",
    error: "#ef4444",
  },
  fonts: {
    heading: interFontFamily,
    body: interFontFamily,
    mono: "'JetBrains Mono', monospace",
  },
  fontSizes: {
    title: 72,
    heading: 48,
    subheading: 36,
    body: 28,
    caption: 32,
    small: 20,
    thumbnailTitle: 64,
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
