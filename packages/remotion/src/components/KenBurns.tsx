import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, Img } from "remotion";

interface KenBurnsProps {
  src: string;
  startScale?: number;
  endScale?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
}

export const KenBurns: React.FC<KenBurnsProps> = ({
  src,
  startScale = 1.0,
  endScale = 1.15,
  startX = 50,
  startY = 50,
  endX = 50,
  endY = 45,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateRight: "clamp",
  });

  const scale = interpolate(progress, [0, 1], [startScale, endScale]);
  const x = interpolate(progress, [0, 1], [startX, endX]);
  const y = interpolate(progress, [0, 1], [startY, endY]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <Img
        src={src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale})`,
          transformOrigin: `${x}% ${y}%`,
        }}
      />
    </div>
  );
};
