# Glossary

Canonical vocabulary for this repo. Terms only — no implementation detail, no
decisions. Decisions live in `docs/adr/` and in the wayfinder tickets under
`.scratch/`.

## Labelling

**Label**
A human judgement recorded against one candidate. Ambiguous on its own, because
a label can be graded without being benchmark-eligible. Prefer the precise term.

**Graded label**
A label carrying a viewer reaction, or a rejection. Cheap: a reject with a
reason is graded. Being graded says a human looked at the candidate and
committed to a verdict; it says nothing about whether the corpus can use it.

**Benchmark-eligible label**
A graded label that *also* carries a complete beat map and all five
classification judgements (context level, context carrier, visual-proof
requirement, primary evidence modality, repetition class) plus an arc intent.
Only benchmark-eligible labels count toward the corpus gate. A graded label
missing one classification field is worth nothing to measurement.

**Beat map**
The six source timestamps describing a candidate's narrative shape: setup start,
premise clear, action start, payoff start, payoff end, reaction end. Complete
means all six are present. May be inherited from automated arc grounding or
corrected by a human.

**Boundary correction**
A human overriding a beat map's start or end. The most valuable single data
point this project produces, because it is the only record of where a clip
*should* have been cut.

**Reaction label**
The viewer's own response to a candidate — distinct from whether the candidate
is well made. A clip can be correctly bounded and still draw no reaction.

**Eligible stream**
A stream with at least one benchmark-eligible label. The corpus gate counts
eligible streams, not labels.

**Held-out stream**
A stream excluded from any fitting, tuning or prompt iteration, reserved for
measuring. A held-out stream is still fully labelled — labelling does not spoil
it. What spoils it is tuning anything against it. "Held out" is a statement
about what the stream is *used* for, never about whether it has labels.

**Honesty**
The system's licence to return fewer candidates than asked for, including none,
when a stream genuinely lacks quality. A labelling session has no keep quota;
zero keeps is a valid and informative result.

## Discovery

**Candidate**
One proposed clip, identified by `jobId:momentId` for its whole life. The same
candidate keeps that identity through grounding, ranking, review and rendering.

**Anchor**
A single timestamp nominated by one recall route, before any boundary is known.
Anchors become candidates by being expanded into a source window.

**Recall route**
An independent method of nominating anchors — transcript, chat reaction, audio
reaction, crowd selection, or gameplay. Routes are deliberately independent so
that recall does not depend on any one of them, and route provenance survives
onto the candidate.

**Lane**
The kind of content a candidate is, which decides how it should be judged and
cut. Conversational humour and visually-driven gameplay are different lanes and
are not one recall problem.

**Arc**
A candidate's complete narrative: setup, escalation or action, payoff, and a
short reaction tail. A candidate without a complete arc is not judged for taste
at all — the arc gate precedes the taste gate.

**Flash**
A short cold-open drawn from inside the candidate's own content range, prepended
to the cut. Editorial, not a property of the source: a source window is not
penalised for lacking a strong natural opening.
