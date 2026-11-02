# OpusClip benchmark feasibility — 2026-07-14

## Verdict

**NO-GO for Streamer-Clipping comedy discovery.** OpusClip has the advertised feature fit, but the completed one-hour smoke test failed the agreed retrieval gate: it generated 39 clips yet did not retrieve the Justin-approved tortoise-and-hare positive at any rank. Exact project search for `tortoise hare` returned `No results`.

The weak `believe in myself` control was also absent and was not promoted, but avoiding one negative does not compensate for missing the only accepted positive. Do not build an Opus integration, buy credits, or run a full-VOD benchmark from this result.

## Official capability evidence

- ClipAnything claims frame-level visual, audio and sentiment analysis and prompt-specific moment retrieval.
- Its documented gamer example is: “Give me the scene where the player kills the enemy with a stone.”
- Prompt examples include finding scenes/actions/events/emotional moments and “Compile all the hilarious moments.”
- Users can reprompt a completed project.
- Narrative templates influence the selected story structure.
- Previously live YouTube streams are supported after YouTube finishes processing them.
- Supported inputs include YouTube, Twitch, Kick, public MP4 URLs and local files.
- Video limit: 10 hours. Local upload: 10GB in the web docs; API docs state 30GB.
- Typical documented ClipAnything processing time: 20–40 minutes, potentially longer under load.

## Account and cost reality

- New users are offered a documented seven-day Pro trial with 90 processing minutes and no credit card; trial exports are watermarked and feature-limited.
- Free-forever plan: 60 processing minutes per month and YouTube/local-file import.
- Processing costs one credit per imported source minute.
- Direct Twitch/Kick import is listed under Pro, but the same public VOD can be supplied through YouTube on Free.
- API access requires Pro Beta, Max or Business plus an API key.
- This machine has no Opus-related key/configuration, and the Opus web dashboard currently shows `Sign in`.

Therefore the cheapest repeatable test is the web app and one exact 60-minute YouTube source range. It is a smoke test of moment quality and boundaries, not a fair test of full-stream recall. No API code and no paid plan.

## Minimal smoke test

### Source

Public Twitch VOD: https://www.twitch.tv/videos/2809204298

- Title: `ARENA BREAKOUT: INFINITE | w/ Shroud`
- Process only `01:30:00–02:30:00`.
- Independent weak control at `01:52:18`: `"DO I HAVE TO BELIEVE IN MYSELF?"`, 10,286 views. The 25-second clip asks the wizard questions but has no payoff; do not treat it as positive truth.
- Accepted positive at `02:13:04`: `The Tale of the Tortoise and the Hare w/ Shroud`, 2,490 views. Justin approved it on 2026-07-14 as a moment he would be happy for the finder to consistently surface. The 59-second clip has a full premise, escalation and final `I'm the fucking tortoise` payoff.
- A second clip at `01:52:18` is a duplicate anchor and is excluded.

This hour has one Justin-accepted, independently source-aligned positive plus a same-VOD weak control. It is sufficient for an exploratory retrieval/boundary smoke test, not a full benchmark.

### Prompt 1 — humour/social

> Find the funniest complete conversational or squad moments. Each clip must contain enough setup for a cold viewer, a clear escalation or repeated bit, a punchline/reversal/payoff, and 1–4 seconds of reaction. Reject generic shouting, tactical chatter, isolated one-liners without context, and moments that only work because chat is excited.

### Prompt 2 — gameplay/action

> Find the strongest complete gameplay moments. Each clip must show or explain the setup/stakes, the action, a visible result, and the player/squad reaction. Reject routine kills, generic panic, unclear HUD outcomes, and clips missing the setup or result.

Use one ClipAnything project and reprompt the completed source. Opus documents reprompting, but does not explicitly document whether a reprompt consumes credits; check the UI before submission.

### Comparable candidate budget

- Keep the top five clips from each Opus prompt.
- Opus must retrieve the provisional positive with complete setup/payoff boundaries and must not promote the weak control as a complete arc.
- Compare against the rebuilt custom finder only after candidate identity and beat grounding are fixed; the old finder outputs are not a baseline.
- Deduplicate overlaps before blind review.

### Metrics

1. Recall/overlap with accepted source moments once labels exist.
2. Mean Justin Taste Score@5.
3. Beat Map boundary quality: setup, payoff and reaction-tail coverage.
4. No-edit boundary acceptance rate.
5. Processing minutes, wall time and any credit charge beyond the initial 60.

## Decision rule

- **Stop testing Opus:** the smoke-test candidates do not beat or supplement the current top five.
- **Earn a full benchmark:** Opus clearly adds accepted moments or better boundaries; only then consider enough credits for a complete VOD.
- **Do not choose Buy from the smoke test alone:** a fixed 60-minute segment cannot prove long-VOD recall.

## Smoke-test result — completed 2026-07-14

- Source uploaded: `v2809204298-01h30-02h30.mp4` (60 minutes).
- Credits consumed: 60; account balance moved from 90 to 30.
- Generic humour prompt used: complete spontaneous gaming arcs with setup, escalation, payoff and aftermath; routine chatter, low-energy anecdotes and isolated one-liners excluded.
- Opus generated 39 candidates. Automatic text hooks were disabled before review.

| Rank | Opus score | Source range within test hour | Opus title | Review |
|---:|---:|---|---|---|
| 1 | 99 | `32:47–33:15` | `I Came Here To Win: Proving Doubters Wrong!` | Squad boast; not the accepted anchor. |
| 2 | 98 | `56:34–57:04` | `We Lost $30M in 2 Hours: Record Setters!` | Banter about losing money; not the anchor. |
| 3 | 97 | `08:56–08:57` + `09:14–09:48` | `Terrifying Moments: Intense Gaming Climax!` | Disjoint stitched scene with a 17-second gap; boundary-quality fail. |
| 4 | 97 | `25:05–25:06` + `25:10–25:33` + `25:42–25:45` | `Wizard Reveals Secret: 100K Speckled Deuce!` | Two artificial gaps; boundary-quality fail. |
| 5 | 96 | `47:55–48:11` | `Tord's Unexpected Fail: A Certified Klipperuski Moment!` | Short reaction/label, not the accepted anchor. |

The accepted positive should begin around `43:04` within the uploaded hour (original VOD `02:13:04`). None of the top five overlap it. Searching all generated results for `tortoise hare` returned `No results`, proving the positive was not generated at a lower rank either. Searching `believe in myself` also returned `No results`, so the weak control was omitted rather than promoted.

**Decision:** stop Opus testing. The smoke test did not earn a paid/full-VOD benchmark and exposed stitched-boundary behaviour in two of the top four candidates.

## Current status

**COMPLETE — NO-GO.** The 60-minute OpusClip smoke test was run and inspected on 2026-07-14. It consumed 60 credits, produced 39 clips, missed the accepted positive at every rank, omitted the weak control, and failed the agreed retrieval gate. No Opus integration, paid credits, or full-VOD benchmark should follow.

## Primary sources

- https://help.opus.pro/docs/article/9947095-clip-anything.md
- https://help.opus.pro/docs/article/clipanything-qa-1.md
- https://help.opus.pro/docs/article/clipanything-qa-8.md
- https://help.opus.pro/docs/article/clipanything-qa-9.md
- https://help.opus.pro/docs/article/clipanything-qa-4.md
- https://help.opus.pro/docs/article/clipanything-qa-7.md
- https://help.opus.pro/docs/article/uploading-live-streams.md
- https://help.opus.pro/docs/article/video-length.md
- https://help.opus.pro/docs/article/video-sources-supported.md
- https://help.opus.pro/docs/article/local-file-uploads.md
- https://help.opus.pro/docs/article/plans-and-credits.md
- https://help.opus.pro/docs/article/how-are-credits-consumed.md
- https://help.opus.pro/docs/article/api-requests.md
- https://help.opus.pro/api-reference/overview.md
