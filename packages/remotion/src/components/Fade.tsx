import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface FadeProps {
  children: React.ReactNode;
  enterDurationFrames?: number;
  exitDurationFrames?: number;
}

export const Fade: React.FC<FadeProps> = ({
  children,
  enterDurationFrames = 10,
  exitDurationFrames = 10,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  let enterOpacity = 1;
  if (enterDurationFrames > 0) {
    enterOpacity = interpolate(
      frame,
      [0, Math.min(enterDurationFrames, durationInFrames - 1)],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
  }

  let exitOpacity = 1;
  if (exitDurationFrames > 0) {
    const exitStart = Math.max(0, durationInFrames - exitDurationFrames);
    if (exitStart < durationInFrames) {
      exitOpacity = interpolate(
        frame,
        [exitStart, durationInFrames],
        [1, 0],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      );
    }
  }

  const opacity = Math.min(enterOpacity, exitOpacity);

  return (
    <div style={{ width: "100%", height: "100%", opacity }}>{children}</div>
  );
};
