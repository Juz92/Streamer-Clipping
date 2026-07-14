# Domain glossary

- **Candidate** — A source-stream time range proposed for review before final trimming or rendering.
- **Performance Positive** — A published Short selected because its audience performance is high. It is evidence of market response, not proof that the moment is funny.
- **Comedy Positive** — A Short whose premise, escalation, and payoff were evidence-reviewed as genuinely comedic. `mixed` and `false` examples are excluded from strict humor-positive training.
- **Taste Positive** — A candidate Justin personally labels `lol` or `smiled`. This is the authoritative label for Justin-specific ranking.
- **Taste Score** — The numeric target for ranking: `lol = 1.0`, `smiled = 0.5`, and `nothing`, `context-missing`, or rejected clips = `0.0`.
- **Hard Negative** — A candidate Justin reviewed and rejected as `nothing`, `not-funny`, generic gameplay, weak premise, or no payoff.
- **Reference Bank** — The callable set of transcripts, Claude Watch evidence, structural summaries, and source media used to compare candidates with known examples.
- **Shadow Ranker** — A ranker that writes evaluation results but cannot change production clip selection until its holdout gate passes.
