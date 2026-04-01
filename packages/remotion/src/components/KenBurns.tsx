import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, Img } from "remotion";

interface KenBurnsProps {
  src: string;
  preset?: string;
  startScale?: number;
  endScale?: number;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
}

const PRESETS: Record<
  string,
  Omit<KenBurnsProps, "src" | "preset">
> = {
  "zoom-in": {
    startScale: 1.0,
    endScale: 1.2,
    startX: 50,
    startY: 50,
    endX: 50,
    endY: 45,
  },
  "zoom-out": {
    startScale: 1.2,
    endScale: 1.0,
    startX: 50,
    startY: 45,
    endX: 50,
    endY: 50,
  },
  "pan-left": {
    startScale: 1.1,
    endScale: 1.1,
    startX: 60,
    startY: 50,
    endX: 40,
    endY: 50,
  },
  "pan-right": {
    startScale: 1.1,
    endScale: 1.1,
    startX: 40,
    startY: 50,
    endX: 60,
    endY: 50,
  },
  "top-to-bottom": {
    startScale: 1.1,
    endScale: 1.1,
    startX: 50,
    startY: 30,
    endX: 50,
    endY: 70,
  },
  "bottom-to-top": {
    startScale: 1.1,
    endScale: 1.1,
    startX: 50,
    startY: 70,
    endX: 50,
    endY: 30,
  },
};

export const KenBurns: React.FC<KenBurnsProps> = (props) => {
  const presetValues = props.preset ? PRESETS[props.preset] : undefined;
  if (props.preset && !presetValues) {
    console.warn(
      `KenBurns: unknown preset "${props.preset}". Valid: ${Object.keys(PRESETS).join(", ")}`
    );
  }
  const {
    src,
    startScale = presetValues?.startScale ?? 1.0,
    endScale = presetValues?.endScale ?? 1.15,
    startX = presetValues?.startX ?? 50,
    startY = presetValues?.startY ?? 50,
    endX = presetValues?.endX ?? 50,
    endY = presetValues?.endY ?? 45,
  } = props;

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
