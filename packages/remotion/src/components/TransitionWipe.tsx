import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface TransitionWipeProps {
  children: React.ReactNode;
  direction?: "left" | "right" | "up" | "down" | "zoom-punch";
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
    case "zoom-punch":
      enterTransform = `scale(${0.3 + enterProgress * 0.7})`;
      exitTransform = `scale(${1 + exitProgress * 0.5})`;
      break;
  }

  const transform = frame < exitStart ? enterTransform : exitTransform;
  const opacity = direction === "zoom-punch"
    ? frame < exitStart ? enterProgress : 1 - exitProgress
    : 1;

  return (
    <div style={{ width: "100%", height: "100%", transform, opacity }}>{children}</div>
  );
};
