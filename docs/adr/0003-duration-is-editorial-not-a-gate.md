# ADR 0003: Duration is an editorial judgement, not a validity gate

## Status

Accepted — 2026-11-02

Decided by Claude on Justin's instruction to resolve the open duration ticket while he was away from the machine. Reversible: the numbers live in one constant and one trim function.

## Context

Duration was enforced in two places, and both were contradicted by the project's own evidence.

`quality-gates.ts` rejected any rendered short longer than 60 seconds. `trim.ts` assigned per-archetype duration targets — 15–25s skill, 22–32s roast, 25–35s story payoff, 18–30s general — and when the detected content ran long it trimmed from the **setup** side to protect the punchline.

Every measurement available points the other way:

- The only short this project has ever rendered is **92.17 seconds**. Its own gate would have discarded it, and only escaped saying so because the job stopped at `rendered` before a pre-render preflight ran.
- One of the six reference hits in `hit-examples.json`, at 7.0M views, is **69 seconds**.
- The 2026-07-14 reassessment found **4 of 16** single-arc reference positives ran over 60s, with a maximum of 118s.
- Three of the eight candidates the ranker itself selected for the first labelling session are **107s, 82s and 77s** — nearly half an unseen blind set.
- YouTube has classified qualifying vertical uploads up to three minutes as Shorts since 2025, so 60 was never a platform limit.

Separately, the reference analysis found 19 of 21 comedy positives show their premise within the first 0–3 seconds. The premise is load-bearing, which makes the setup the worst thing to cut.

## Decision

**Duration is not a pass/fail property of a clip. It is an editorial one.**

1. The render gate enforces **platform validity only**: `MIN_SHORT_DURATION_SEC = 10`, `MAX_SHORT_DURATION_SEC = 180`. Below ten seconds there is no room for setup, payoff and a reaction tail; above three minutes YouTube stops treating it as a Short. Nothing between those bounds is a gate failure.
2. **Length belongs to ranking, not gating.** A 150-second candidate that drags should lose on editorial strength, where the cost is visible and comparable, rather than being silently discarded by a constant.
3. **Never trim the setup to reach a target duration.** If a complete arc does not fit a target, the arc wins and the target is reported, not enforced. `getTrimTargets` becomes advisory.
4. **The flash cold-open stays**, and arc scoring must not penalise a source window for lacking a strong natural first three seconds. Hooks are editorial and synthesized at edit time; judging source quality by edit quality confuses the two.

## Consequences

- Clips between 60 and 180 seconds now render. Some will be too long, and retention will say so — which is the feedback loop that was missing, where a hard gate produced no signal at all.
- The 92-second rendered short and the long candidates in the first labelling session become renderable, so the labelling session can judge them as content instead of having them pre-filtered by a number.
- Point 1 is implemented. **Points 2–4 are decided but not yet implemented**: `trim.ts` still assigns and enforces archetype targets, and still trims setup-side. That is a substantial change inside a 99KB module and is tracked as its own ticket rather than attempted alongside the gate.
- The 25–45s sweet spot recorded in CLAUDE.md stays true as guidance about what usually works. It stops being a rule the code enforces against measured counter-evidence.
- Risk accepted: raising a ceiling is easier than restoring editorial discipline later. If retention shows long clips underperforming, the correct response is to teach ranking to penalise length, not to reinstate the gate.
