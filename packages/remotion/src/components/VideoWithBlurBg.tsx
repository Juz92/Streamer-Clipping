import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";

interface VideoWithBlurBgProps {
  src: string;
  style?: React.CSSProperties;
}

/**
 * Renders a video with a blurred/darkened copy as background.
 * The sharp video is centered with objectFit: "contain" (shows full width),
 * while the blurred copy fills any empty space above/below.
 * This prevents the heavy side-cropping that objectFit: "cover" causes
 * when displaying landscape video in a portrait frame.
 */
export const VideoWithBlurBg: React.FC<VideoWithBlurBgProps> = ({
  src,
  style,
}) => {
  const resolvedSrc = staticFile(src);
  return (
    <AbsoluteFill style={style}>
      {/* Blurred background — fills the entire frame */}
      <OffthreadVideo
        src={resolvedSrc}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          filter: "blur(20px) brightness(0.3)",
          transform: "scale(1.1)",
        }}
      />
      {/* Sharp video — zoomed 25% to fill more of the portrait frame */}
      <OffthreadVideo
        src={resolvedSrc}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          transform: "scale(1.60)",
        }}
      />
    </AbsoluteFill>
  );
};
