# What labelling protocol clears the gold-corpus gate?

Label: `wayfinder:grilling`
Mode: HITL
Parent: [Map: A measurable clip-finder](../MAP.md)
Blocked by: —
Claimed: 2026-11-02, this session
Closed: 2026-11-02 — see [Resolution](#resolution)

## Resolution

**The labelling protocol, as decided.**

A labelling session covers one stream and presents **8 candidates**, blind-mixed
as 3 top-ranked, 3 mid-ranked and 2 known-good seeds. The human sees no
indication of which is which. There is no keep quota: zero keeps is a valid
result, and the floor that matters is 6 benchmark-eligible labels per stream
(`shadow-scorecard.ts:69`), which 8 clears with room for two unusable ones.

Per candidate the human supplies exactly **two** judgements — a `reaction` and a
`contextLevel` ("would a cold viewer understand this?") — then confirms or
overrides **five pipeline-proposed fields**: the beat map,
`primaryEvidenceModality`, `visualProofRequired`, `contextCarrier` and
`repetitionClass`, all derivable from `arc-grounding.json`. `arcIntent` and, on
a reject, `rejectionReason` complete the record. All seven eligibility fields
stay mandatory; what changed is who produces them.

**The corpus reaches READY on the three streams already on disk.** No downloads.

| Stream | Job | What the session does | Media |
|---|---|---|---|
| `gp4sqhiaxNo` | `job-004` | desk-complete the 5 existing labels with the 5 never-collected fields; extend to 6 | none needed |
| `H-_9Fgs5tIg` | `job-005` | label fresh — 5 rendered shorts already exist, extend to 6 | 5 shorts |
| `DRR2zh3YscM` | `job-006` | label fresh from the calibration pack, extend to 6 | 11.5 GB source |

**Excluded:** the four source-aligned official Shorts are not boundary labels
(coverage 0.14–0.61); they are reused as the known-good seeds instead.
**Written off:** `wKJwi-MMLJQ`'s five labels — no beat source, no grounding, no
media, unrecoverable without re-downloading the VOD to rescue five rejections.

**Nothing is held out yet.** Holding back two of three streams would leave one
to fit on. The first corpus therefore proves that labelling completes end to
end; it cannot yet prove the finder generalises. Held-out streams get downloaded
before the first real measurement, not before the first labels.

Two follow-on tickets created:
[09 — Freeze and enforce the label schema](09-freeze-label-schema.md) and
[10 — Run the three labelling sessions](10-run-labelling-sessions.md).

Terms pinned in [GLOSSARY.md](../../../GLOSSARY.md): graded label,
benchmark-eligible label, beat map, boundary correction, eligible stream,
held-out stream, honesty.

## Question

The destination is a system we can prove works on unseen streams. The
instrument for that proof is the gold corpus, and it is stalled two labels
short of being usable:

```
"gate": { "status": "WAITING_FOR_LABELS", "labels": 10, "required": 12, "streams": 2 }
"baseline": { "blockers": [
  "Need 3 more benchmark-eligible streams",
  "Need at least 6 benchmark-eligible candidates per held-out stream" ] }
```

`gold-corpus.ts:367` requires 3 benchmark-eligible streams. We have 2.

This is the cheapest unblock on the whole map and it has been sitting for four
months, which suggests the obstacle is the labelling process, not the
labelling. So the question is about the protocol, not the threshold:

1. **What exactly does one labelling session ask of Justin?** The reassessment
   lists keep/reject/reserve, lane, reaction label, rejection reason, corrected
   setup/payoff/natural-end boundaries, cold-open acceptable y/n, and
   single-arc-versus-compilation. That is eight judgements per candidate. If
   that is why it stalled, which are load-bearing and which are aspirational?
   The corrected source boundaries are named as the most valuable data in the
   project — the rest may be negotiable.
2. **How many candidates per stream, and chosen how?** The last session
   presented 10 shadow-ranked candidates and all 10 were rejected as "not
   really funny". Labelling only the ranker's picks teaches nothing when the
   ranker is the thing under test — a blanket rejection is indistinguishable
   from a boring stream. Should the set be deliberately mixed: some top-ranked,
   some mid, some known-good from the aligned official Shorts?
3. **Do the 4 aligned official Shorts count as labels?**
   `training/official-shorts/source-vod-alignments.json` maps 4 real Shorts to
   source VODs with start/end seconds and coverage 0.14–0.61. These are
   boundaries a competent editor actually chose. If they count, the gate may
   already be closer than the scorecard thinks — but coverage of 0.14 means the
   alignment is partial, and a partial alignment is a weak boundary label.
4. **Which streams are held out, and are they held out before or after labelling?**
   A held-out stream that was labelled while visible is not held out.
5. **Is "allowed to return fewer than three candidates" a real behaviour?**
   The reassessment lists honesty as a gate — the system may return nothing
   when a VOD lacks quality. If a labelling session has no quota, a stream
   where Justin picks zero is a valid, informative result rather than a failed
   session. Confirm that.

Do not resolve this by lowering the thresholds. The gate refusing to promote is
the system working; the fix is supplying it labels, or agreeing a cheaper
protocol that still produces the boundary corrections.

## Comments

### 2026-11-02 — the premise of this ticket was wrong

The ticket opens by saying the gate is "two labels short". It is not. **Zero of
the ten existing labels are benchmark-eligible, and none ever were.**

`gold-corpus.ts:268` requires *seven* things simultaneously:

```
labelStrength === "graded"        (a reaction, or status === reject)
&& hasCompleteBeatMap(beatMap)    (all six beats present)
&& contextLevel != null
&& contextCarrier != null
&& visualProofRequired != null
&& primaryEvidenceModality != null
&& repetitionClass != null
&& arcIntent != null
```

Field-by-field audit of the ten decisions in `manual-review-feedback.json`:

| Field | Filled |
|---|---:|
| `reaction` | 10/10 |
| `rejectionReason` | 6/10 |
| `correctedBeats` | 5/10 |
| `arcIntent` | 5/10 |
| `contextLevel` | **0/10** |
| `contextCarrier` | **0/10** |
| `visualProofRequired` | **0/10** |
| `primaryEvidenceModality` | **0/10** |
| `repetitionClass` | **0/10** |

Five of the seven required fields have **never been collected once**, from
either stream. The review pack never asked for them. So the gate has never been
handed a single complete label and has been correctly reporting
`WAITING_FOR_LABELS` for four months for a reason nobody read.

The two sessions also used different schemas: stream `wKJwi-MMLJQ` collected no
`correctedBeats` and no `arcIntent` at all; stream `gp4sqhiaxNo` added both,
plus a `coldOpenAccepted` field that the eligibility check does not use. The
label schema drifted between sessions and nothing reconciled it.

Consequences for this ticket:

- The friction was never Justin's willingness. It is that the instrument asked
  the wrong questions. "Labelling has stalled" is better read as "labelling has
  never once completed".
- Re-labelling the **existing** ten candidates with the five missing fields may
  be cheaper than labelling new streams — the clips, beats and reactions are
  already there. But `gold-corpus.ts:367` needs three *streams*, and only two
  exist, so at least one new stream is required regardless.
- `labelStrength` is satisfied by a bare reject with a reason, so rejects are
  cheap labels. Eligibility is what is expensive, and it costs the same for a
  reject as for a keep.

### 2026-11-02 — two different gates are both called "labels"

A terminology collision worth fixing before it causes another four months:

- `shadow-scorecard.json` → `ranking.gate` reports `labels: 10, required: 12`,
  counted from `private-review`. This is the **ranking** gate.
- `gold-corpus.ts` → `benchmark` reports `requiredEligibleStreams: 3`,
  counted from benchmark-eligible records. This is the **corpus** gate. It does
  not count labels at all; it counts streams.
- The same scorecard separately reports
  `labels: { graded: 0, ungraded: 0, benchmarkEligible: 0 }` for job-006.

Three counters, three definitions, one word. The map's framing of "10/12
labels" came from the ranking gate and does not describe the corpus gate at all.

### 2026-11-02 — round 1 settled (Justin: yes to all four)

1. **All seven eligibility fields stay mandatory.** The gate is the
   measurement; weakening it defeats the purpose. But five of the seven become
   **pipeline-proposed and human-confirmed**: `primaryEvidenceModality`,
   `visualProofRequired`, `contextCarrier`, `repetitionClass` and the beat map
   are all derivable from `arc-grounding.json`. The human supplies only
   `reaction` and `contextLevel`, and overrides the rest where wrong.
2. **The four aligned official Shorts are not boundary labels.** Coverage runs
   0.14–0.61, so three of four match only a minority of the Short's transcript.
   They are reused as known-good *seeds* in labelling sets instead.
3. **A labelling set is 8 per stream, blind-mixed**: 3 top-ranked, 3 mid-ranked,
   2 known-good. Labelling only the ranker's own picks cannot distinguish a
   broken ranker from a boring stream — which is exactly what the last session
   produced. No keep quota.
4. **Held-out streams are named in the map before labelling begins**, not after.

### 2026-11-02 — correction to decision 4's reasoning

Decision 4 stands, but the reason given for it was wrong. The round-1 argument
was "a held-out stream you labelled while it was visible isn't held out". The
code says otherwise: `shadow-scorecard.ts:69` requires **at least 6
benchmark-eligible candidates per held-out stream**, and line 85 *throws* if a
baseline stream has fewer than six score-aligned labels.

So a held-out stream must be fully labelled. Holding out is about what the
stream is *used for* — no fitting, no tuning, no prompt iteration against it —
not about withholding labels. Recorded in [GLOSSARY.md](../../../GLOSSARY.md).

That 6-per-stream floor also retroactively justifies decision 3: a set of 8
clears it with two to spare.

### 2026-11-02 — what can actually be labelled, from surviving assets

Four job directories survive. Only one still has its source video.

| Job | Stream | Phase | Source video | Beat source | Media for review | Existing labels |
|---|---|---|---|---|---|---|
| `job-002` | unknown | no manifest | — | none | none | — |
| `job-004` | `gp4sqhiaxNo` | notebooklm-reviewed | **gone** | `arc-grounding.json` + 5/5 `correctedBeats` | none (0 shorts) | 5 |
| `job-005` | `H-_9Fgs5tIg` | **rendered** | gone | `arc-grounding.json` | **5 shorts, 3 raw clips** | **0** |
| `job-006` | `DRR2zh3YscM` | notebooklm-reviewed | **11.5 GB present** | `arc-grounding.json` + calibration pack | derivable from source | 0 |

Key consequences:

- **`job-005` is a free stream nobody labelled.** It reached `rendered`, has 5
  finished shorts and a 5-entry private-review pack, and carries zero labels.
  It is the cheapest eligible stream available and was invisible in the earlier
  framing of this ticket.
- **`wKJwi-MMLJQ` is unrecoverable.** Its five labels have `correctedBeats`
  0/5, and the stream has no job directory, no `arc-grounding.json` and no
  media — only a stray `wKJwi-MMLJQ-youtube-metadata.json` at the clips root.
  With no beat source, those five labels cannot become benchmark-eligible
  without re-downloading the VOD and re-running grounding.
- **`benchmarkEligible` does not require media.** `mediaAvailable` is tracked
  as a separate field and is absent from the eligibility conjunction at
  `gold-corpus.ts:268`. So `job-004` can be completed from transcript, notes
  and its existing beats without its video — a desk exercise.
- **Three eligible streams are reachable with zero downloads**: `job-004`
  (add the 5 classification fields to existing labels), `job-005` (label fresh,
  media present), `job-006` (label fresh, source present). Each currently
  shapes to a 5-candidate set and needs extending to 6 to clear the floor;
  `job-006`'s `arc-grounding.json` holds 143 grounded candidates, so extending
  is trivial.

### 2026-11-02 — a defect listed in the reassessment is already fixed

The reassessment (§4D) reported that `ingest-review-decision.ts` reads
`moments.json` as an object with a `moments` property while the file is an
array, silently dropping lane and scorer features. That is **no longer true**:
line 338 types it as a union and line 340 narrows with `Array.isArray`. Do not
spend time on it.
