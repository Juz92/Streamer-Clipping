import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDecisionTemplate, parseMetadataTitles } from "../dist/prepare-review.js";

test("parses generated metadata titles and seeds review decision template", () => {
  const titles = parseMetadataTitles(`
## 01 -- fallback-title (Score: 1)

**YouTube Shorts Title:** Better Title

## 02 -- Keep This -- POST FIRST (Score: 2)
`);

  assert.equal(titles.get(1), "Better Title");
  assert.equal(titles.get(2), "Keep This");

  const decision = JSON.parse(buildDecisionTemplate("stream-1", [
    { rank: 1, candidateId: "job-001:moment-1", momentId: "moment-1", file: "01-a.mp4", title: "Better Title", thumb: null },
    { rank: 2, candidateId: "job-001:moment-2", momentId: "moment-2", file: "02-b.mp4", title: "Keep This", thumb: null },
  ], 1));

  assert.equal(decision.chosenRank, 1);
  assert.equal(decision.acceptedSuggestedPick, null);
  assert.equal(decision.decisions.length, 2);
  assert.equal(decision.decisions[0].candidateId, "job-001:moment-1");
  assert.equal(decision.decisions[0].momentId, "moment-1");
  assert.equal(decision.decisions[0].status, "reserve");
  assert.equal(decision.decisions[0].lane, null);
  assert.equal(decision.decisions[0].reaction, null);
  assert.equal(decision.decisions[0].rejectionReason, null);
  assert.equal(decision.decisions[0].coldOpenAccepted, null);
  assert.equal(decision.decisions[0].correctedBeats, null);
  assert.equal(decision.decisions[0].arcIntent, "single-arc");
  assert.equal(decision.decisions[0].rightsStatus, "unresolved");
  assert.equal(decision.decisions[0].publishApproved, false);
  assert.throws(() => buildDecisionTemplate("stream-1", [
    { rank: 1, candidateId: "job-001:moment-1", momentId: "wrong", file: "01-a.mp4", title: "Bad", thumb: null },
  ], null), /does not match/);
});
