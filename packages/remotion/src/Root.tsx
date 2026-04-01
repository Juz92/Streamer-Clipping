import React from "react";
import { Composition, Still } from "remotion";
import { GamingShort } from "./compositions/GamingShort/index";
import { gamingShortSchema } from "./compositions/GamingShort/schema";
import { Thumbnail } from "./compositions/Thumbnail/index";
import { thumbnailSchema } from "./compositions/Thumbnail/schema";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="GamingShort"
        component={GamingShort}
        durationInFrames={900}
        fps={30}
        width={1080}
        height={1920}
        schema={gamingShortSchema}
        defaultProps={{
          clipSrc: "stream.mp4",
          layoutMode: "gameplay" as const,
          avatarRegion: { x: 24, y: 24, w: 380, h: 380 },
          gameplayRegion: { x: 0, y: 0, w: 1920, h: 1080 },
        }}
        calculateMetadata={async ({ props }) => {
          return { durationInFrames: props.durationFrames ?? 900 };
        }}
      />
      <Still
        id="Thumbnail"
        component={Thumbnail}
        width={1280}
        height={720}
        schema={thumbnailSchema}
        defaultProps={{
          title: "Daily Peanut Clips",
          accentColor: "#d4a017",
          variant: "bold" as const,
        }}
      />
    </>
  );
};
