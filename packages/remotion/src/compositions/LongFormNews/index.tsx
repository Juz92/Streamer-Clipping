import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import type { LongFormNewsProps, ShotInput } from "./schema";
import { TitleCard } from "./scenes/TitleCard";
import { Screenshot } from "./scenes/Screenshot";
import { TextCard } from "./scenes/TextCard";
import { CTA } from "./scenes/CTA";
import { Caption } from "../../components/Caption";
import { theme } from "../../styles/theme";

function renderShot(shot: ShotInput) {
  switch (shot.type) {
    case "screenshot":
      return (
        <Screenshot
          src={shot.src!}
          caption={shot.caption}
          kenBurns={shot.kenBurns}
        />
      );
    case "text_card":
      return <TextCard heading={shot.heading || ""} body={shot.body} />;
    case "browser_recording":
      return (
        <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
          <video
            src={shot.src}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        </AbsoluteFill>
      );
    default:
      return null;
  }
}

export const LongFormNews: React.FC<LongFormNewsProps> = ({
  title,
  subtitle,
  shots,
  audioSrc,
  captionWords,
  titleDurationFrames = 150,
  ctaDurationFrames = 150,
}) => {
  let currentFrame = 0;

  const titleStart = currentFrame;
  currentFrame += titleDurationFrames;

  const shotSequences = shots.map((shot) => {
    const start = currentFrame;
    currentFrame += shot.durationFrames;
    return { shot, from: start, durationInFrames: shot.durationFrames };
  });

  const ctaStart = currentFrame;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.colors.bg }}>
      {audioSrc && (
        <Audio src={audioSrc} />
      )}

      <Sequence from={titleStart} durationInFrames={titleDurationFrames}>
        <TitleCard title={title} subtitle={subtitle} />
      </Sequence>

      {shotSequences.map(({ shot, from, durationInFrames }) => (
        <Sequence
          key={shot.id}
          from={from}
          durationInFrames={durationInFrames}
        >
          {renderShot(shot)}
        </Sequence>
      ))}

      <Sequence from={ctaStart} durationInFrames={ctaDurationFrames}>
        <CTA />
      </Sequence>

      {captionWords && captionWords.length > 0 && (
        <Caption words={captionWords} />
      )}
    </AbsoluteFill>
  );
};
