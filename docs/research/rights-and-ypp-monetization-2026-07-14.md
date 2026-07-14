# Rights and YouTube monetization assessment — 2026-07-14

## Decision summary

The current edits are better than a raw repost, but captions, vertical reframing, split-screen layout, hook text and thumbnails do **not** make the project automatically safe.

There are two independent gates:

1. **Copyright/right to publish:** permission from the rights holder, or a defensible legal exception.
2. **YouTube Partner Program originality:** the channel must show meaningful, substantive, channel-unique contribution. Permission alone does not satisfy this gate.

The lowest-risk commercial model is:

> Operate as an official editor/partner, preferably publishing to a creator-controlled channel. If Justin uses his own channel, obtain written commercial clipping permission from TheBurntPeanut/Loaded **plus** use a commentary-led editorial format where our narration, framing or analysis is visibly responsible for the story—not merely the captions and layout.

This is a product/platform assessment, not legal advice.

---

## 1. YouTube treats rights and monetization as separate questions

YouTube defines reused content as repurposed online material without significant original commentary, substantive modification, or added educational/entertainment value. It says viewers must be able to tell there is a meaningful difference between the original and the upload.

Its allowed examples include:

- clips used for critical review;
- rewritten dialogue and changed voiceover;
- sports replays where the uploader explains successful moves;
- reaction videos with commentary;
- edited footage where the uploader adds a storyline and commentary;
- reused footage with audio/visual effects that demonstrate substantive editing and make it unique to the channel.

Its disallowed examples include:

- clips compiled with little or no narrative;
- promotion of someone else's content, even with permission;
- downloaded/copied footage without substantive modification;
- making minimal changes and calling the result original.

Most importantly, YouTube states that the reused-content rule applies **even when the original creator gave permission**, because reused-content eligibility is separate from copyright, permission, and fair use.

Review is channel-wide. Reviewers may focus on the main theme, most-viewed videos, newest videos, biggest share of watch time, metadata, and the About section.

YouTube's Shorts monetization policy separately lists reuploads of other creators' content and compilations with no original content as ineligible engaged views. The YPP application process uses both automated systems and human reviewers to review the channel as a whole.

**Primary sources:**

- [YouTube channel monetization policies](https://support.google.com/youtube/answer/1311392?hl=en)
- [YouTube Shorts monetization policies](https://support.google.com/youtube/answer/12504220?hl=en)
- [YouTube Partner Program overview and eligibility](https://support.google.com/youtube/answer/72851?hl=en)

---

## 2. What our current format actually changes

The current renderer is not a one-click crop. `packages/clips/src/render-fast.ts` implements:

- a stream-specific two-panel vertical layout;
- separate reframed Peanut/avatar and gameplay crops;
- rank-specific gameplay framing;
- karaoke-style word captions;
- frame-zero hook text and thumbnails;
- selective setup/payoff/reaction boundaries;
- stream-specific layout corrections and presentation QA.

These are real production edits. They support an argument that the footage has received substantive **visual editing** and is unique to the channel.

However, the present Daily Peanut format generally still:

- preserves the source creator's dialogue and entertainment performance as the central substance;
- does not add our own spoken commentary or analysis;
- does not visibly feature the uploading creator;
- does not reliably create a new narrative beyond selecting and presenting the original moment;
- can look templated when repeated across a channel.

### Policy-risk assessment

| Current contribution | Helpful? | Remaining weakness |
|---|---:|---|
| Complete-arc selection and tighter boundaries | Yes | Editorial judgement is not always visible to a reviewer |
| Split-screen avatar/gameplay layout | Yes | Reframing alone may be treated as presentation rather than new substance |
| Dynamic captions | Yes | Captions mostly reproduce the source dialogue rather than add commentary |
| Frame-zero hook and title | Yes | A brief hook does not necessarily create a new storyline |
| Thumbnails and metadata | Yes | Metadata cannot transform the underlying video by itself |
| Repeated automated house style | Mixed | Can trigger generic/inauthentic-content concerns if videos feel interchangeable |
| Original narration, criticism or analysis | No | This is the clearest missing transformation |

### Bottom line

The format is **arguable**, not automatically prohibited. But it is not strong enough to call “all okay.” For an entire monetized channel based on one other creator's streams, the reused-content risk remains **medium-high**.

---

## 3. Copyright and permission remain separate

YouTube states that copyright owners decide who can use and distribute their work. Its safe-use options include permission, an applicable copyright exception, public-domain material, or a suitable licence. It also says none of those options guarantees avoiding a claim or strike.

YouTube's fair-use guidance says adding new meaning or expression helps, but fair use is case-specific and ultimately decided by courts. Commercial use, taking the heart of the work, and affecting the owner's market can weigh against it.

Australia does not have a broad US-style fair-use rule. The Australian Attorney-General describes specific fair-dealing purposes such as criticism/review, news reporting, research/study, parody and satire. A commercial highlights channel that republishes the entertaining core of a stream is not obviously covered merely because it adds captions and a new layout.

The official TheBurntPeanut YouTube channel currently publishes a business contact in its channel description: `theburntpeanut@loaded.gg`. No public clipping licence or permission policy was found during this review.

Permission from TheBurntPeanut can only license rights TheBurntPeanut/Loaded actually controls. It may not clear third-party music, videos watched on stream, memes, guests/co-streamers, game-publisher restrictions, sponsor assets, or another person's likeness. Those elements need their own clearance or must be excluded/muted.

**Primary sources:**

- [Copyright on YouTube](https://support.google.com/youtube/answer/2797466?hl=en)
- [Fair use on YouTube](https://support.google.com/youtube/answer/9783148?hl=en)
- [Australian Attorney-General — Copyright basics](https://www.ag.gov.au/rights-and-protections/copyright/copyright-basics)
- [Australian Attorney-General — Copyright users](https://www.ag.gov.au/rights-and-protections/copyright/copyright-users)
- [Australian Copyright Act 1968](https://www.legislation.gov.au/C1968A00063/latest/text)
- [Official TheBurntPeanut YouTube channel](https://www.youtube.com/@TheBurntPeanut)

---

## 4. Content ID and Shorts-specific risk

A matching upload can receive a Content ID claim even without a strike. The rights holder may block, monetize, or track matching footage.

YouTube states that active claims on one-to-three-minute Shorts block those Shorts regardless of the claimant's usual policy. The project should therefore avoid assuming that a longer qualifying Short is commercially safe simply because YouTube supports a three-minute duration.

**Primary source:** [YouTube — Content ID claim basics](https://support.google.com/youtube/answer/6013276?hl=en)

---

## 5. Platform sourcing also matters

YouTube's Terms do not provide a general right to download and independently reuse other users' content; use must be enabled by the service or authorised by the relevant rightsholder. Twitch's user-content and sharing provisions likewise do not amount to a blanket commercial reupload licence.

The safer production route is to receive creator-supplied source files or use an expressly authorised export/remix workflow. Keep a rights record per clip: source file/URL, permission basis, third-party elements, edit notes, approval date, and any removal restrictions.

**Primary sources:**

- [YouTube Terms of Service](https://www.youtube.com/static?template=terms)
- [Twitch Terms of Service](https://legal.twitch.com/en/legal/terms-of-service/)
- [Twitch DMCA Guidelines](https://legal.twitch.com/en/legal/dmca-guidelines/)

---

## 6. Options

### Option A — Official editor/partner, commentary-led format — recommended

Prefer publishing to or for a creator-controlled channel. If Justin owns the destination channel, obtain written commercial permission from TheBurntPeanut/Loaded, then make the channel's contribution obvious through narration, analysis, story framing, ranking, or a distinct editorial premise.

**Risk:** lowest of the three, although YPP approval is never guaranteed.

### Option B — Commentary-led channel without permission

Make the edit genuinely analytical, critical, parodic, or otherwise transformative and be prepared to defend copyright exceptions.

**Risk:** YPP position improves, but copyright/claim exposure remains. Australian fair dealing is narrower than US fair use.

### Option C — Captions/layout/highlight selection only

Continue the current format and rely on technical editing as substantive modification.

**Risk:** medium-high YPP reused-content risk and high rights uncertainty without permission. Not recommended as the foundation of an autonomous commercial system.

---

## 7. Recommended permission scope

If permission is pursued, the written agreement should cover:

- Twitch, YouTube, Kick and any other source platforms included;
- YouTube Shorts, TikTok, Instagram and other destinations;
- commercial monetization and sponsorships;
- permission to download, crop, caption, edit and create derivative promotional clips;
- attribution and channel-branding requirements;
- treatment of third-party music/game footage that TheBurntPeanut may not control;
- takedown and approval process;
- exclusivity or non-exclusivity;
- term, territory and termination;
- any revenue share;
- access to source VODs or clean exports where available.

Permission solves the creator-rights relationship; it does **not** guarantee YPP reused-content eligibility.

---

## 8. Recommended editorial specification

To strengthen YPP eligibility, each Short should visibly contain original contribution beyond presentation:

1. **Original premise:** our narrator or on-screen editorial voice explains why this moment matters.
2. **Source evidence:** use only the source portion needed to support that premise.
3. **Original interpretation:** add commentary, explanation, ranking, comparison, context, or a clearly authored storyline.
4. **Distinct ending:** our conclusion, callback or editorial payoff—not merely the source clip ending.
5. **Channel disclosure:** About/descriptions should explain the editorial process and identify the original contribution.
6. **Per-video variation:** avoid a mass-produced template where only the source footage changes.

A token AI-voice intro/outro around an otherwise untouched clip is not a reliable fix. The original contribution should drive the video's structure.

---

## Decision required

Before autonomous public posting, decide whether written creator permission is a hard requirement.

**Recommendation:** yes. Seek written commercial permission and build the commentary-led format in parallel. Keep the current captions/layout system as production polish, not as the sole legal/YPP transformation.
