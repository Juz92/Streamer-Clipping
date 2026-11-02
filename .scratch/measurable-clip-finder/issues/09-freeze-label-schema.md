# Freeze and enforce the label schema

Label: `wayfinder:task`
Mode: AFK
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —

## Question

Nothing to decide on the protocol — ticket 05 settled that. This is the
hardening that stops the next labelling session wasting itself, and it must land
before [10 — Run the three labelling sessions](10-run-labelling-sessions.md).

The failure to prevent: the two existing labelling sessions used **different
schemas**. Stream `wKJwi-MMLJQ` collected no `correctedBeats` and no `arcIntent`;
stream `gp4sqhiaxNo` added both, plus a `coldOpenAccepted` field that the
eligibility check never reads. Nothing reconciled them, and the drift was
invisible — the gate simply reported `WAITING_FOR_LABELS` for four months while
holding ten labels, none eligible.

Done when:

- `ingest-review-decision.ts` rejects a decision missing **any** of the seven
  eligibility inputs, not just the four it currently throws on (it already
  validates `arcIntent`, `contextLevel`, `primaryEvidenceModality` and
  `repetitionClass` at lines 206–225; `contextCarrier`, `visualProofRequired`
  and a complete beat map need the same treatment). A session must not be able
  to produce an ineligible label silently.
- A **schema version** is stamped into the review pack and into
  `manual-review-feedback.json`, and a pack written against one version cannot
  be read as another without an explicit migration. `manual-review-feedback.json`
  already carries `"version": 2` — make it mean something.
- `coldOpenAccepted` is either wired into eligibility or dropped. Collecting a
  field nothing reads is how the drift started.
- A test covers the case that actually happened: a decision missing
  `contextLevel` must fail loudly, and a corpus built from such a record must
  not report it as eligible. `packages/clips/test/` already holds
  `gold-corpus.test.ts` and `ingest-review-decision.test.mjs` to extend.
- Note the live obstacle: there is **no `test` script in any package.json**, so
  nothing runs the 30 existing test files. Adding one is in scope here if that
  is what it takes to make this check real; the alternative is a test nobody
  executes, which is the same class of mistake as a field nobody reads.

The answer records what was enforced, the schema version, and whether the test
harness now runs.

## Comments
