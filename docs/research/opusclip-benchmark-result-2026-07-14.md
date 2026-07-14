# OpusClip smoke-test benchmark — 2026-07-14

## Verdict: FAIL

Project: `P3671406ejr`
Source: `v2809204298-01h30-02h30.mp4` (60:00; Twitch VOD 2809204298, original 01:30:00–02:30:00)
Processing: completed; project opened successfully; 39 outputs generated.

Pass rule: the accepted positive at uploaded offset **00:43:04** (original VOD **02:13:04**), “The Tale of the Tortoise and the Hare w/ Shroud” (~59s), must appear in the top five with complete setup/payoff boundaries, while the weak control at uploaded offset **00:22:18** (original **01:52:18**) must not be promoted.

## Top five ranked outputs

| Rank | Score | Duration | Opus title | Uploaded-file source time shown by Opus | Original VOD time | Visible subgrades |
|---:|---:|---:|---|---|---|---|
| 1 | 99/100 | 00:28 | I Came Here To Win: Proving Doubters Wrong! | 32:47–33:15 | 02:02:47–02:03:15 | Hook A; Flow A-; Value A; Trend A |
| 2 | 98/100 | 00:30 | We Lost $30M in 2 Hours: Record Setters! | 56:34–57:04 | 02:26:34–02:27:04 | Hook A-; Flow A; Value A; Trend A- |
| 3 | 97/100 | 00:34 | Terrifying Moments: Intense Gaming Climax! | 08:56–08:57 and 09:14–09:48 | 01:38:56–01:38:57 and 01:39:14–01:39:48 | Hook A; Flow A-; Value A; Trend A- |
| 4 | 97/100 | 00:27 | Wizard Reveals Secret: 100K Speckled Deuce! | 25:05–25:06, 25:10–25:33, and 25:42–25:45 | 01:55:05–01:55:06, 01:55:10–01:55:33, and 01:55:42–01:55:45 | Hook A; Flow A-; Value A; Trend A- |
| 5 | 96/100 | 00:15 | Tord's Unexpected Fail: A Certified Klipperuski Moment! | 47:55–48:11 | 02:17:55–02:18:11 | Hook A; Flow A; Value A; Trend A- |

## Rule evaluation

- **Accepted positive:** not in the top five. None of the five source windows overlaps 00:43:04. Opus's in-project search for `tortoise` also returned **“No results”** among the existing clips.
- **Boundary test:** not reached. Because the accepted positive was not promoted into the top five, it cannot satisfy the required complete setup/payoff boundary condition.
- **Weak control:** not promoted. None of the top-five source windows overlaps 00:22:18.
- **Final decision:** **FAIL**. The weak-control condition passed, but the mandatory accepted-positive recall/ranking condition failed.

## Inspection notes

I opened the detail panes for ranks 1–5 and checked the previews, scene-analysis transcripts, durations, scores, and displayed source-time ranges rather than judging from titles alone. The top-five transcript content covered map/doubter banter, losing $30M, a smoke/thermal fight, the “wizard/speckled deuce” sequence, and a “Klipperuski” reaction. None matched the tortoise-and-hare setup/payoff at 00:43:04. Rank 1's preview was also played in the grid to confirm the preview content and controls were live.
