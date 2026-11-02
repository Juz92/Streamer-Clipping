# Domain glossary

- **Source Anchor** — A raw-VOD timestamp/window plus provenance from one recall route. Anchors nominate regions; they are not publish decisions.
- **Recall Union** — The uncapped, source-time-ordered union of semantic nominations and scorer/chat/audio anchors. Overlapping routes merge without losing `routeEvidence`; ranking never deletes recall candidates.
- **Candidate Arc** — A bounded raw-stream region expanded around one or more Source Anchors. One immutable `candidateId` must survive grounding, trimming, rendering, review, and outcome joins.
- **Candidate ID** — The job-scoped identity `${jobId}:${momentId}` assigned when a candidate enters the pool. Rank and mutable source/trim boundaries are never identity. A conflicting ID fails closed.
- **Beat Map** — The temporal structure of a Candidate Arc: `setupStart`, `premiseClear`, `actionOrEscalationStart`, `payoffStart`, `payoffEnd`, `reactionEnd`, and optional `flashMoment`.
- **Arc Gate** — Objective editorial checks applied before taste: understandable premise, meaningful escalation/action, visible or audible payoff, clean ending, useful reaction tail, no missing context, and visual proof for gameplay nominations.
- **Recall Lane** — An independent candidate-nomination route. Conversational humour and visually driven gameplay use different evidence even when they share downstream grounding.
- **Editorial Short** — The rendered output. Added titles, captions, flash opens, commentary, and pacing belong to the edit and must not be confused with the natural quality of the raw source start.
- **Compilation Candidate** — Multiple unrelated micro-arcs intentionally packaged as one Editorial Short. It is not a valid single-arc retrieval label.
- **Performance Positive** — A published Short selected because audience performance is high. It is evidence of market response, not proof that the moment is funny or source-aligned.
- **Comedy Positive** — A Short whose premise, escalation, and payoff were evidence-reviewed as genuinely comedic. `mixed` and `false` examples are excluded from strict humour-positive training.
- **Taste Positive** — A candidate Justin personally labels `lol` or `smiled`. This is the authoritative label for Justin-specific ranking.
- **Taste Score** — `lol = 1.0`, `smiled = 0.5`; `nothing`, `context-missing`, rejected, or otherwise unapproved = `0.0`.
- **Hard Negative** — A candidate Justin rejected as `nothing`, `not-funny`, generic gameplay, weak premise, missing context, bad cut, or no payoff.
- **Reference Bank** — Edited output examples and their structural evidence. Unless aligned to a raw VOD, it is an editorial pattern library rather than source-discovery ground truth.
- **Shadow Ranker** — A ranker that writes evaluation results but cannot alter production selection until its holdout gate passes.
- **Risk-Accepted Publish** — Publishing an Editorial Short without written creator permission after the owner has explicitly accepted the documented copyright and YPP risks. It is not a claim of legality, fair dealing, affiliation, or monetization eligibility.
- **Claim Kill Switch** — The mandatory response to a creator removal request or copyright claim: unpublish the affected Short and do not dispute, appeal, or counter-notify unless clear written rights evidence covers the claimed material.
