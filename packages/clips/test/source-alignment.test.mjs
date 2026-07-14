import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordYoutubePerformance,
  recordYoutubePublication,
} from "../dist/lib/candidate-pool.js";

test("joins a YouTube publication to one exact source VOD window", () => {
  const dir = mkdtempSync(join(tmpdir(), "source-alignment-"));
  const poolPath = join(dir, "candidate-pool.json");
  const original = {
    version: 1,
    updatedAt: "2026-07-01T00:00:00.000Z",
    candidates: [
      {
        jobId: "job-a",
        momentId: "nlm-001",
        streamId: "source-vod-a",
        streamDate: "2026-07-01",
        startSec: 4359,
        endSec: 4423,
        categories: ["peanut-bits"],
        viralScore: 90,
        durationSec: 64,
        hook: "winner",
        status: "pending",
        statusUpdatedAt: "2026-07-01T00:00:00.000Z",
      },
      {
        jobId: "job-b",
        momentId: "nlm-001",
        streamId: "source-vod-b",
        streamDate: "2026-07-02",
        startSec: 100,
        endSec: 140,
        categories: [],
        viralScore: 50,
        durationSec: 40,
        hook: "same local ID in another job",
        status: "pending",
        statusUpdatedAt: "2026-07-02T00:00:00.000Z",
      },
    ],
  };

  writeFileSync(poolPath, JSON.stringify(original, null, 2));
  try {
    const linked = recordYoutubePublication(poolPath, {
      candidateId: "job-a:nlm-001",
      videoId: "AbCdEf123_-",
      postedAt: "2026-07-11T12:34:56.000Z",
    });
    const saved = JSON.parse(readFileSync(poolPath, "utf8"));

    assert.equal(linked.streamId, "source-vod-a");
    assert.equal(linked.candidateId, "job-a:nlm-001");
    assert.equal(linked.startSec, 4359);
    assert.equal(linked.endSec, 4423);
    assert.equal(saved.candidates[0].youtubeVideoId, "AbCdEf123_-");
    assert.equal(saved.candidates[0].candidateId, "job-a:nlm-001");
    assert.equal(saved.candidates[0].youtubeUrl, "https://youtube.com/shorts/AbCdEf123_-");
    assert.equal(saved.candidates[0].status, "posted-daily");
    assert.equal(saved.candidates[0].postedDate, "2026-07-11");
    assert.equal(saved.candidates[1].status, "pending");

    const labelled = recordYoutubePerformance(poolPath, {
      videoId: "AbCdEf123_-",
      observedAt: "2026-07-14T13:00:00.000Z",
      views: 1200,
      averageViewPercentage: 88,
      shares: 17,
    });
    assert.equal(labelled.youtubePerformance.mature72h, true);
    assert.equal(labelled.youtubePerformance.views, 1200);
    assert.equal(labelled.streamId, "source-vod-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
