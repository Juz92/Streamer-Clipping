import React from "react";
import { Composition, Still } from "remotion";
import { LongFormNews } from "./compositions/LongFormNews/index";
import { longFormNewsSchema } from "./compositions/LongFormNews/schema";
import { Thumbnail } from "./compositions/Thumbnail/index";
import { thumbnailSchema } from "./compositions/Thumbnail/schema";

const defaultLongFormProps = {
  title: "AI News Today",
  subtitle: "The latest in artificial intelligence",
  shots: [
    {
      id: "demo-1",
      type: "text_card" as const,
      heading: "Breaking AI News",
      body: "This is a preview of the LongFormNews template.",
      durationFrames: 90,
    },
    {
      id: "demo-2",
      type: "text_card" as const,
      heading: "Key Takeaway",
      body: "Templates are driven by data from the pipeline database.",
      durationFrames: 90,
    },
  ],
  titleDurationFrames: 150,
  ctaDurationFrames: 150,
};

const defaultThumbnailProps = {
  title: "GPT-5 Just Changed Everything",
  accentColor: "#6366f1",
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="LongFormNews"
        component={LongFormNews}
        durationInFrames={
          defaultLongFormProps.titleDurationFrames +
          defaultLongFormProps.shots.reduce((sum, s) => sum + s.durationFrames, 0) +
          defaultLongFormProps.ctaDurationFrames
        }
        fps={30}
        width={1920}
        height={1080}
        schema={longFormNewsSchema}
        defaultProps={defaultLongFormProps}
        calculateMetadata={async ({ props }) => {
          const totalFrames =
            (props.titleDurationFrames ?? 150) +
            props.shots.reduce((sum: number, s: { durationFrames: number }) => sum + s.durationFrames, 0) +
            (props.ctaDurationFrames ?? 150);
          return { durationInFrames: totalFrames };
        }}
      />
      <Still
        id="Thumbnail"
        component={Thumbnail}
        width={1280}
        height={720}
        schema={thumbnailSchema}
        defaultProps={defaultThumbnailProps}
      />
    </>
  );
};
