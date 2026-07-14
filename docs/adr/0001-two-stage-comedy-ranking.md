# ADR 0001: Two-stage comedy discovery and taste ranking

## Status

Accepted — 2026-07-13

## Context

High-view Shorts provide evidence of audience response but do not encode Justin's personal taste. Justin's labels are precise but currently sparse. Previous single-stage activity, embedding, and multimodal judges either over-approved generic moments or missed known winners.

## Decision

Use two separate stages:

1. **Audience-comedy recall** compares stream candidates with evidence-reviewed comedy positives to avoid missing broadly understandable funny moments.
2. **Justin-taste ranking** uses Justin's `lol` / `smiled` decisions and hard negatives to order the recalled candidates.

Both stages remain shadow-only until an unseen-VOD holdout gate passes: mean Taste Score@5 must be at least `0.60`, and the new ranker must beat the current ranker on at least two of three unseen VODs.

## Consequences

- High views remain a weak performance label, never a substitute for humor or taste.
- Public edited Shorts may inform semantic structure and references; production promotion still depends on Justin-labelled holdouts.
- Recall and ranking can fail independently and are measured separately.
