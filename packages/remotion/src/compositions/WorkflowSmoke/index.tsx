import React from "react";
import { AbsoluteFill, Audio, interpolate, staticFile, useCurrentFrame } from "remotion";

export const WorkflowSmoke: React.FC<Record<string, unknown>> = (props) => {
  const audioSrc = typeof props.audioSrc === "string" ? props.audioSrc : undefined;
  const label = typeof props.label === "string" ? props.label : "Remotion workflow smoke";
  const frame = useCurrentFrame();
  const scale = interpolate(frame, [0, 30], [0.92, 1.04], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "linear-gradient(135deg, #050505, #201400 60%, #d4a017)", justifyContent: "center", alignItems: "center" }}>
      {audioSrc ? <Audio src={staticFile(audioSrc)} volume={0.35} /> : null}
      <div style={{ transform: `scale(${scale})`, color: "white", fontFamily: "Inter, Arial, sans-serif", fontSize: 34, fontWeight: 900, textAlign: "center", padding: 28, borderRadius: 22, background: "rgba(0,0,0,.55)", boxShadow: "0 20px 60px rgba(0,0,0,.45)" }}>
        {label}
      </div>
    </AbsoluteFill>
  );
};
