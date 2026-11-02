# YouTube Shorts metadata and frame-zero research — 2026-07-16

## Decision summary

Use a **paired thumbnail package** for every Editorial Short:

1. one intentionally selected avatar-expression frame embedded as video frame zero;
2. one exported still that exactly matches frame zero for review and optional custom-thumbnail upload.

The embedded frame is still useful, but the old claim that YouTube Shorts cannot accept an uploaded thumbnail is no longer universally true. YouTube's current Android help says verified accounts can select an auto-generated thumbnail or upload a custom image. It also warns that vertical videos with 16:9 custom thumbnails may be replaced by an auto-generated 4:5 thumbnail on Home, Explore and Subscriptions; the custom thumbnail remains on the watch feed, watch history and non-mobile platforms. That makes an intentional in-video frame a useful fallback, not the only thumbnail mechanism.

## Primary-source findings

### Discovery and retention

YouTube says Shorts are discovered in the Shorts feed, Search, Home, channel pages, Subscriptions and notifications. Shorts-feed ranking uses:

- whether viewers choose to view, ignore or mark a Short not interested;
- average view duration;
- average percentage viewed;
- likes and post-watch surveys;
- viewer/topic personalization and external factors such as topic interest, competition and seasonality.

For Search, YouTube says metadata match matters **and** whether viewers click and watch. Metadata cannot rescue a weak promise or weak retention.

Source: [Search & discovery tips — Shorts tab](https://support.google.com/youtube/answer/11914225?hl=en)

### Titles and thumbnails

YouTube recommends accurate titles; succinct titles with important words near the beginning; limited ALL CAPS and emoji; universal emotion such as a shocked face for casual audiences; and simple composition, readable text and rule-of-thirds placement.

Source: [Thumbnail & title tips](https://support.google.com/youtube/answer/12340300?hl=en)

### Descriptions and keywords

YouTube recommends a unique description per video, one or two primary words/phrases repeated naturally in the title and description, and using the first few lines to describe the video because those lines are visible before “more.” Search terms are matched against the video and description.

Source: [Tips for video descriptions](https://support.google.com/youtube/answer/12948449?hl=en)

### Tags

YouTube says title, thumbnail and description are more important than tags. Tags play a minimal discovery role except for commonly misspelled terms. The current generator's 33–37 generic tags are therefore noise, not an evidence-backed SEO strategy.

Source: [Add tags to your YouTube videos](https://support.google.com/youtube/answer/146402?hl=en)

### Current thumbnail mechanics

YouTube's current Android instructions allow a verified account to choose an auto-generated thumbnail or upload a custom image. For vertical videos, surface-specific replacement/cropping can still occur. The package must therefore survive both 9:16 playback and a center-biased 4:5 thumbnail treatment.

Source: [Add custom thumbnails on YouTube — Android](https://support.google.com/youtube/answer/72431?co=GENIE.Platform%3DAndroid&hl=en)

## Local evidence

### Current pipeline audit

- Job 005 metadata contains only three titles and three frame-zero hooks; it lacks descriptions, search intent, tags, pinned comments, posting order and explicit expression-frame selection.
- `render-fast.ts` takes frame zero from the first frame of each raw clip. It does not use the best-expression timestamp.
- `generate-thumbnails.ts` separately selects a source frame from `thumbnailSec` or audio energy, then deliberately sets `hookText = ""`. Its JPG and embedded frame zero disagree.
- The embedded renderer uses outlined text without the hook banner Justin described.
- Current text sits low enough that its second line is vulnerable to a center 4:5 crop.

### Official BurntPeanut public corpus

The local public snapshot contains 500 official Shorts. A visual audit of the eight highest-view thumbnails found:

- all eight preserve visible gameplay context;
- five show no designed text;
- three show ordinary in-video captions, not a dedicated hook banner;
- the avatar is either a circular head in the upper portion or a full-body avatar in the lower portion;
- there is no repeated dedicated banner treatment.

Eight recent thumbnails also showed no dedicated hook banner; most use a watermark plus a large avatar, gameplay, or both.

Evidence:

- `data/clips/job-005-2026-07-14/qa-frame0-research/official-top8-large.jpg`
- `data/clips/job-005-2026-07-14/qa-frame0-research/official-recent8-large.jpg`
- `data/clips/official-burntpeanut-shorts-flat.json`

**Interpretation:** “best avatar expression + hook banner” is Justin's channel packaging hypothesis, not a proven pattern from the official channel. Implement it cleanly and measure it; do not present it as settled algorithm truth.

## Frame-zero system decision

Each clip must declare:

- an explicit `frame0OffsetSec` into the approved raw clip;
- a two-line `frame0Hook`, using `/` as the deliberate line break;
- no more than three visible words per line;
- an accurate promise that the clip pays off;
- an exported matching still.

Design rules:

1. Use the strongest clearly readable avatar expression selected from a contact sheet; never default to clip start or pure audio peak.
2. Keep the avatar face unobstructed and dominant.
3. Use one full-width high-contrast banner, not floating text.
4. Keep the banner in a center-4:5-safe vertical band (approximately y=1280–1560 on a 1080×1920 frame).
5. Use white setup text and yellow payoff text with a black stroke; no more than two lines.
6. Embed the art for one video frame only, so playback immediately becomes the approved avatar/gameplay layout.
7. Export the exact first decoded frame as `yt-NN.jpg`; never create a second divergent composition.

## Job 005 expression choices

| Rank | Local frame offset | Source timestamp | Why |
|---:|---:|---:|---|
| 1 | 84.0s | 4625.36s | extreme open-mouth reaction during escalation |
| 2 | 29.5s | 4823.02s | strongest high-contrast expression near payoff |
| 3 | 27.0s | 22160.20s | centered open-mouth reaction; avoids the dual-avatar edge crop later in the clip |

Contact sheets live under `data/clips/job-005-2026-07-14/qa-frame0-research/`.

## Metadata package decision

- **Title:** accurate, concrete and concise; one searchable entity/topic near the front where natural; no hashtag stuffing.
- **Description:** unique first sentence naming the creator/topic and event; second sentence adds context; links follow the visible first lines.
- **Hashtags:** 2–3 relevant hashtags in the description, not the title.
- **Tags:** creator spelling variants, game/topic and genuine misspellings only.
- **Pinned comment:** one clip-specific question answerable after watching.
- **Frame-zero hook:** complements the title instead of repeating vague generic copy.

## Measurement plan

Treat the packaging as a cohort experiment:

- primary feed metric: percentage who chose to view / engaged views;
- retention guardrails: average view duration and average percentage viewed;
- Search metric: YouTube Search traffic and search terms, plus CTR where that surface reports impressions;
- quality guardrail: comments indicating a misleading title/thumbnail promise;
- after the repaired baseline, test one packaging variable per cohort.

Public views alone cannot prove thumbnail or title causality; private Analytics is required.
