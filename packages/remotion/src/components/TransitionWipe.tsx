import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface TransitionWipeProps {
  children: React.ReactNode;
  direction?: "left" | "right" | "up" | "down";
  durationFrames?: number;
}

export const TransitionWipe: React.FC<TransitionWipeProps> = ({
  children,
  direction = "left",
  durationFrames = 15,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const enterProgress = interpolate(frame, [0, durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const exitStart = durationInFrames - durationFrames;
  const exitProgress = interpolate(
    frame,
    [exitStart, durationInFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  let enterTransform = "";
  let exitTransform = "";

  switch (direction) {
    case "left":
      enterTransform = `translateX(${(1 - enterProgress) * 100}%)`;
      exitTransform = `translateX(${-exitProgress * 100}%)`;
      break;
    case "right":
      enterTransform = `translateX(${-(1 - enterProgress) * 100}%)`;
      exitTransform = `translateX(${exitProgress * 100}%)`;
      break;
    case "up":
      enterTransform = `translateY(${(1 - enterProgress) * 100}%)`;
      exitTransform = `translateY(${-exitProgress * 100}%)`;
      break;
    case "down":
      enterTransform = `translateY(${-(1 - enterProgress) * 100}%)`;
      exitTransform = `translateY(${exitProgress * 100}%)`;
      break;
  }

  const transform = frame < exitStart ? enterTransform : exitTransform;

  return (
    <div style={{ width: "100%", height: "100%", transform }}>{children}</div>
  );
};
