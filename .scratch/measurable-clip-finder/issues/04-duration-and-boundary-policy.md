# What is the duration policy, and does story or duration win?

Label: `wayfinder:grilling`
Mode: HITL
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —
Claimed: 2026-11-02, this session
Closed: 2026-11-02 — see [Resolution](#resolution)

## Resolution

**Decided by me, on Justin's instruction to resolve this while he was away from
the machine.** This is a HITL ticket and he can overturn any of it; the evidence
was one-directional enough that I was willing to call it. Recorded as
[ADR 0003](../../../docs/adr/0003-duration-is-editorial-not-a-gate.md).

**Duration is an editorial judgement, not a validity gate.**

1. The render gate enforces platform validity only: `MIN_SHORT_DURATION_SEC = 10`
   and `MAX_SHORT_DURATION_SEC = 180`. Nothing between those is a gate failure.
   **Implemented** in `quality-gates.ts`, with the test fixture moved from 75s —
   which now legitimately passes — to 200s so the ceiling is still exercised.
2. Length belongs to **ranking**, not gating. A 150s candidate that drags should
   lose on editorial strength, where the cost is visible, rather than vanish.
3. **Never trim the setup to reach a target.** 19 of 21 reference positives show
   their premise in the first 0–3 seconds, so the premise is load-bearing and is
   the worst thing to cut. If a complete arc does not fit, the arc wins and
   `getTrimTargets` becomes advisory.
4. The flash cold-open **stays**, and arc scoring must not penalise a source
   window for a weak natural opening. Hooks are synthesized at edit time;
   judging source quality by edit quality confuses the two.

Points 2–4 are decided but **not implemented** — `trim.ts` still enforces
archetype targets and still trims setup-side. That is a substantial change in a
99 KB module and is tracked as
[14 — Make trim story-first](14-make-trim-story-first.md) rather than attempted
next to a one-constant gate change.

The dead end this ticket warned about was avoided: the `trim.ts:728` sweet-spot
nudge was not re-tuned. It is inside the frame the evidence says is wrong.

## Question

The system currently enforces duration twice, and the evidence says both
enforcements are wrong.

- `quality-gates.ts:37` rejects any rendered short longer than 60 seconds.
- `trim.ts:707` assigns per-archetype duration targets — 15–25s skill,
  22–32s roast, 25–35s story payoff, 18–30s general — and when the detected
  content runs long it trims from the **setup** side to protect the punchline.

Against that, `hit-examples.json` holds six clips with 5.0M–10.0M views at
durations 24, 25, 26, 35, 42 and **69** seconds. One of six proven winners is
already illegal under the gate. The reassessment's wider count found 4 of 16
single-arc positives ran over 60s, and YouTube has classified qualifying
vertical uploads up to three minutes as Shorts since 2025 — so 60 is a number
this project chose, not a platform limit.

Decide:

1. **Does the hard duration gate survive at all**, and if so at what value?
   Three minutes is the platform ceiling; 60s is current; the evidence supports
   something near 75–90s. A gate that rejects a 69-second 7M-view clip is
   measurably miscalibrated.
2. **When a complete arc does not fit the target, what gives?** The
   reassessment's position is that boundary logic should locate the narrative
   beats first and treat duration as a soft editorial constraint. Accepting
   that means `getTrimTargets` stops being an input to the cut and becomes a
   report on it. Is that the call?
3. **Is trimming from the setup side ever right?** It preserves the punchline
   and deletes the premise that makes the punchline land. The reference
   analysis found 19 of 21 positives show their premise within 0–3 seconds —
   which suggests the premise is load-bearing and should be the last thing cut.
4. **Where does the cold open fit?** Raw clips currently prepend a 2-second
   flash drawn from inside the content range. The reassessment argues hooks are
   editorial — synthesized by the editor, not required to be present in the
   source — so a source window should not be penalised for a weak natural
   opening. Does the flash stay, and does arc scoring stop judging the first
   three seconds?

A dead end to avoid re-walking: the "duration sweet spot" adjustment at
`trim.ts:728` already nudges targets by ±3s from competitive-intel data. That is
tuning inside a frame the evidence says is wrong. Do not resolve this ticket by
re-tuning those numbers.

## Comments

### 2026-11-02 — the project's own only rendered short is 92 seconds

Measured with ffprobe once OneDrive hydrated the media:

| File | Dimensions | Duration |
|---|---|---:|
| `job-005/shorts/01-mary-poppins-...mp4` | 1080x1920 | **92.17 s** |
| `job-005/raw-clips/01-mary-poppins-...mp4` | 1920x1080 | 92.17 s |
| `job-005/raw-clips/02-sex-wheel-...mp4` | 1920x1080 | 42.08 s |
| `job-005/raw-clips/03-bdsm-pal-freakout-...mp4` | 1920x1080 | 56.08 s |

The single finished short this project has ever produced is **92 seconds long**,
and `quality-gates.ts:37` rejects any rendered short over 60. The pipeline built
something its own gate would throw away, and the gate never got the chance to
say so because `job-005` stopped at `rendered` before any pre-render preflight
ran against it.

This is stronger evidence than the `hit-examples.json` argument already in this
ticket. That one says the gate would reject other people's winners; this says
the gate rejects *our own only output*. Taken together, the 60-second constant
is contradicted by every piece of duration evidence the project holds.

Note also that the render preserved duration exactly — raw and rendered are both
92.1666 s — so nothing in the current trim or render path is enforcing the limit
that the gate enforces. The two disagree, and the gate is the one that is wrong.
