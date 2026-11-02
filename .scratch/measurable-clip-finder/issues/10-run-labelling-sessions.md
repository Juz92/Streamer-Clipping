# Run the three labelling sessions

Label: `wayfinder:task`
Mode: HITL
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: [08 — Prototype the labelling surface](08-labelling-surface-prototype.md), [09 — Freeze and enforce the label schema](09-freeze-label-schema.md)

## Question

Nothing to decide. This is the work that turns the corpus gate from
`WAITING_FOR_LABELS` to `READY`, and it is the only thing on the map that no
agent can do: the judgements are Justin's.

Protocol is fixed by [05](05-labelling-protocol.md). Per stream: 8 candidates,
blind-mixed 3 top / 3 mid / 2 known-good seeds, no keep quota. Per candidate
Justin gives a `reaction` and a `contextLevel`, then confirms or overrides five
pipeline-proposed fields. Six benchmark-eligible labels per stream is the floor.

Three sessions, in this order — see the 2026-11-02 correction below for why
this ordering changed:

1. **`job-006` / `DRR2zh3YscM`** — the only stream with a source video
   (10.7 GB) and now the only one with chat (100% coverage, 7,714 chatters).
   143 grounded candidates to draw from, and `calibration-pack.json` already
   holds 5 blind candidates with null label slots in the right shape. Extend to
   8. This is the only stream where fresh clips can be cut, so it is the only
   one that can produce a full 8-candidate blind-mixed set as the protocol
   specifies.
2. **`job-005` / `H-_9Fgs5tIg`** — 3 raw clips and 1 rendered short, no source
   video. The rendered short is worth labelling first of the three: it is the
   only candidate in the whole corpus where Justin judges a *finished* short, so
   it is the one data point that can tell us whether the renderer or the finder
   is at fault when a candidate disappoints. The remaining 3+ candidates needed
   to clear the 6-label floor must be desk-labelled from `arc-grounding.json`.
3. **`job-004` / `gp4sqhiaxNo`** — a desk exercise, no source video. Five
   graded labels exist with complete corrected beats; they need only the five
   never-collected classification fields. No media required, because
   `benchmarkEligible` does not depend on `mediaAvailable`. Extend to 6.

Done when `gold-corpus.ts` reports `benchmark.status: "READY"` with
`eligibleStreams: 3`, and the shadow scorecard's ranking gate stops blocking on
label count.

Record, in the answer: minutes per candidate, which field Justin hesitated on
most, and how many of the 2 known-good seeds per stream he kept. That last
number is the diagnostic — if he rejects the seeds too, the problem is how
candidates are cut, not how they are ranked.

**Do not** lower a threshold to reach READY. The gate refusing to promote is
the system working correctly; the whole point of this chain is to feed it, not
to argue with it.

## Comments

### 2026-11-02 — the media inventory in this ticket was wrong

Written while OneDrive had every media file dehydrated, so the counts came from
directory listings rather than from files anyone could open. Once OneDrive was
started and the files pinned, all seven job-005 media files hydrated in 28
seconds. The real inventory:

| Job | Stream | Source video | Media candidates | Existing labels |
|---|---|---|---:|---:|
| `job-004` | `gp4sqhiaxNo` | **none** — only `stream.en.vtt` + transcript | 0 | 5 |
| `job-005` | `H-_9Fgs5tIg` | **none** — only `stream.en.vtt` + transcript | 3 raw clips, 1 of them also rendered | 0 |
| `job-006` | `DRR2zh3YscM` | **10.7 GB present** | cuttable from source | 0 |

Two claims in the original ticket were false:

- **"`job-005` — 5 rendered shorts already on disk."** Its `shorts/` directory
  holds **one** `.mp4`. The five entries I counted were that one video, three
  `karaoke-NN.ass` caption files, and a `thumbnails/` subdirectory. With 3 raw
  clips total it can supply at most 3 media-backed candidates, against a floor
  of 6.
- **"`job-005` first, cheapest and most informative."** It is neither. It has no
  source video, so no further clips can be cut from it — the shortfall to 6 must
  be desk-labelled regardless.

`job-006` is therefore the strongest stream, not the weakest: the only source
video, the only chat timeline, 143 grounded candidates, and a calibration pack
already shaped for blind review. Order corrected above.

### 2026-11-02 — ffmpeg is installed but unreachable, which blocks session 1

Cutting fresh clips from `job-006` needs ffmpeg. Both binaries exist at
`%LOCALAPPDATA%\Microsoft\WinGet\Links\` but neither `ffmpeg` nor `ffprobe`
resolves on `PATH` from Git Bash *or* PowerShell. CLAUDE.md lists them as
external tools the pipeline depends on, and `render-fast.ts`, `preview.ts` and
the audio analyser all shell out to them.

This is the same failure class as the yt-dlp cookies config in
[ticket 01](01-recover-chat-replay.md#a-second-worse-blocker-found-on-the-way):
a tool that is present, assumed, and not actually callable. The user's `PATH` is
extremely long, which on Windows can silently truncate and drop entries — a
likely cause worth checking before adding yet another entry.

Fix the PATH, or have the pipeline resolve the binaries explicitly the way
`discover.ts` now resolves cookies. Until then session 1 cannot cut clips,
though the `calibration-pack.json` candidates can still be labelled from the
existing `arc-grounding.json` beats without touching video.
