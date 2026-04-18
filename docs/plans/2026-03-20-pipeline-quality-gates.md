# Pipeline Quality Gates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 7 quality gates to the pipeline that catch visual/asset issues before expensive renders, reducing the feedback loop from ~5 min render cycles to ~10s preview checks.

**Architecture:** Each improvement is a self-contained addition to an existing pipeline module (render.ts, b-roll.ts, visual-plan.ts, assets.ts). No new packages. No new DB tables. Changes are additive — existing CLI interfaces stay backward-compatible, new flags are added.

**Tech Stack:** TypeScript ESM, better-sqlite3/Drizzle ORM, ffprobe (for media validation), Remotion CLI (for still rendering)

---

## Task 1: Shot-Level Preview (`render.ts --preview`)

Extract one frame per shot as a JPEG contact sheet — catches visual issues in ~10s instead of a 5-min render.

**Files:**
- Modify: `packages/pipeline/src/render.ts`

**Step 1: Add `--preview` flag parsing after the existing `--job` arg parsing (after line 30)**

Insert right after the `jobId` validation block (after line 30), alongside the existing flow:

```ts
const previewMode = args.includes("--preview");
```

**Step 2: Add the preview function before `main()`**

Insert before the `async function main()` line (before line 18). This function generates props, renders one still per shot using `remotion still`, and creates a contact sheet summary.

```ts
import { mkdirSync } from "fs";

async function renderPreview(jobId: number): Promise<void> {
  const db = getDb();
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (!job) { log.error(`Job ${jobId} not found`); process.exit(1); }

  const script = db.select().from(schema.scripts).where(eq(schema.scripts.jobId, jobId)).get();
  if (!script) { log.error(`No script for job ${jobId}`); process.exit(1); }

  const visualPlan = db.select().from(schema.visualPlans).where(eq(schema.visualPlans.jobId, jobId)).get();
  if (!visualPlan) { log.error(`No visual plan for job ${jobId}`); process.exit(1); }

  const idea = db.select().from(schema.ideas).where(eq(schema.ideas.id, job.ideaId)).get();
  const jobAssetBase = join(DATA_DIR, `assets/job-${jobId}`);
  const previewDir = join(jobAssetBase, "output", "preview");
  mkdirSync(previewDir, { recursive: true });

  let playerName: string | undefined;
  let seriesDisplayName: string | undefined;
  let playerImageSrc: string | undefined;

  if (idea?.playerId) {
    const player = db.select().from(schema.players).where(eq(schema.players.id, idea.playerId)).get();
    if (player) {
      playerName = player.shortName;
      const portraitPath = join(jobAssetBase, "images", `${player.slug}-portrait.jpg`);
      if (existsSync(portraitPath)) playerImageSrc = portraitPath;
    }
    const rawFormat = idea.seriesFormat as SeriesFormat | null;
    if (rawFormat && rawFormat in SERIES_DISPLAY_NAMES) {
      seriesDisplayName = SERIES_DISPLAY_NAMES[rawFormat].replace("[Player]", playerName ?? "");
    }
  }

  const shots = visualPlan.shots as ShotPlan[];
  const videoFormat = job.videoFormat ?? "short_form";
  const fps = 30;
  const remotionRoot = resolve("packages/remotion/src/index.ts");

  // Build minimal remotion shots (same mapping as full render)
  const jobAssets = db.select().from(schema.assets).where(eq(schema.assets.jobId, jobId)).all();

  function toRelativeSrc(filePath: string): string {
    const absBase = resolve(jobAssetBase);
    const absFile = resolve(filePath);
    if (absFile.startsWith(absBase)) return absFile.slice(absBase.length + 1).replace(/\\/g, "/");
    return absFile.replace(/\\/g, "/");
  }

  const remotionShots = shots.map((shot) => {
    const asset = jobAssets.find((a) => a.shotId === shot.id);
    let src: string | undefined;
    if (asset) src = toRelativeSrc(asset.filePath);

    return {
      id: shot.id,
      type: shot.type,
      src,
      caption: shot.caption,
      source: shot.source,
      heading: shot.type === "text_card" ? shot.textContent || shot.caption : undefined,
      durationFrames: msToFrames(shot.durationMs, fps),
      kenBurns: shot.kenBurns,
      transition: shot.transition ?? "fade",
      timelineEvents: shot.timelineEvents,
      clubName: shot.clubName,
      backgroundClip: shot.backgroundClip,
    };
  });

  const musicPath = existsSync(join(jobAssetBase, "audio", "music.mp3")) ? "audio/music.mp3" : undefined;
  const audioAsset = jobAssets.find((a) => a.type === "audio");

  // Determine composition based on format
  const isLong = videoFormat === "long_form";
  const compositionId = isLong ? "LongFormStory" : "FootballShort";

  // Build the same props as a normal render, but we'll render stills at specific frames
  let inputProps: Record<string, unknown>;
  if (isLong) {
    const chapterMap = new Map<string, typeof remotionShots>();
    for (const shot of remotionShots) {
      const rawShot = shots.find(s => s.id === shot.id);
      const chapterName = rawShot?.chapter ?? "Untitled";
      if (!chapterMap.has(chapterName)) chapterMap.set(chapterName, []);
      chapterMap.get(chapterName)!.push(shot);
    }
    const chapters = Array.from(chapterMap.entries()).map(([title, chShots]) => ({ title, shots: chShots }));
    inputProps = {
      title: script.youtubeTitle, playerName: playerName ?? "", seriesTitle: seriesDisplayName ?? "",
      chapters, playerImageSrc: playerImageSrc ? toRelativeSrc(playerImageSrc) : undefined,
      musicSrc: musicPath, musicVolume: 0.08,
    };
  } else {
    inputProps = {
      hookText: script.hookText, playerName: playerName ?? "", seriesTitle: seriesDisplayName ?? "",
      shots: remotionShots, playerImageSrc: playerImageSrc ? toRelativeSrc(playerImageSrc) : undefined,
      musicSrc: musicPath, musicVolume: 0.12, platform: "youtube_shorts",
      ctaText: "Subscribe",
    };
  }

  const propsPath = resolve(previewDir, "preview-props.json");
  writeFileSync(propsPath, JSON.stringify(inputProps, null, 2), "utf-8");

  // Calculate the frame offset for the midpoint of each shot
  const HOOK_FRAMES = 90;
  const INTRO_FRAMES = 300;
  const CHAPTER_TITLE_FRAMES = 90;
  let frameOffset = isLong ? INTRO_FRAMES : HOOK_FRAMES;

  // For long-form, account for chapter title cards
  let currentChapter: string | null = null;

  const shotFrames: { id: string; frame: number }[] = [];
  for (const shot of shots) {
    if (isLong && shot.chapter && shot.chapter !== currentChapter) {
      frameOffset += CHAPTER_TITLE_FRAMES;
      currentChapter = shot.chapter;
    }
    const durationFrames = msToFrames(shot.durationMs, fps);
    const midFrame = frameOffset + Math.floor(durationFrames / 2);
    shotFrames.push({ id: shot.id, frame: midFrame });
    frameOffset += durationFrames;
  }

  log.info(`Rendering ${shotFrames.length} preview frames...`, { jobId });

  for (const { id, frame } of shotFrames) {
    const outPath = join(previewDir, `${id}.jpg`);
    try {
      execSync(
        `npx remotion still "${remotionRoot}" ${compositionId} "${outPath}" --props "${propsPath}" --frame ${frame} --image-format jpeg --quality 70 --public-dir "${jobAssetBase}"`,
        { cwd: process.cwd(), stdio: "pipe", timeout: 30000 }
      );
    } catch (e) {
      log.warn(`Preview failed for shot ${id} at frame ${frame}: ${e instanceof Error ? e.message : "unknown"}`);
      // Write a placeholder text file instead
      writeFileSync(outPath + ".error", `Failed to render frame ${frame}`);
    }
  }

  // Summary
  const rendered = shotFrames.filter(sf => existsSync(join(previewDir, `${sf.id}.jpg`)));
  const failed = shotFrames.filter(sf => !existsSync(join(previewDir, `${sf.id}.jpg`)));

  console.log(`\nPreview complete: ${rendered.length}/${shotFrames.length} frames`);
  console.log(`Output: ${previewDir}/`);
  for (const sf of shotFrames) {
    const exists = existsSync(join(previewDir, `${sf.id}.jpg`));
    const shot = shots.find(s => s.id === sf.id)!;
    const marker = exists ? "[OK]" : "[FAIL]";
    console.log(`  ${marker} ${sf.id} (${shot.type}, frame ${sf.frame})`);
  }
  if (failed.length > 0) {
    console.log(`\n${failed.length} shots failed to render — check the .error files.`);
  }
}
```

**Step 3: Add early return for preview mode in main()**

Right after the `previewMode` const (after the job ID validation), add:

```ts
if (previewMode) {
  await renderPreview(jobId);
  return;
}
```

**Step 4: Verify it works**

Run: `npx tsx packages/pipeline/src/render.ts --job 9 --preview`
Expected: Creates `data/assets/job-9/output/preview/` with one JPG per shot (~10-30s total).

**Step 5: Commit**

```bash
git add packages/pipeline/src/render.ts
git commit -m "feat: add --preview mode to render.ts — one frame per shot in ~10s"
```

---

## Task 2: Asset Validation Pre-flight (`render.ts --preflight`)

Runs before any render to check all media files exist, have acceptable resolution, and portrait is present. Catches missing/broken assets before wasting render time.

**Files:**
- Modify: `packages/pipeline/src/render.ts`

**Step 1: Add preflight function**

Add after the `renderPreview` function:

```ts
function runPreflight(jobId: number): boolean {
  const db = getDb();
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (!job) { log.error(`Job ${jobId} not found`); return false; }

  const visualPlan = db.select().from(schema.visualPlans).where(eq(schema.visualPlans.jobId, jobId)).get();
  if (!visualPlan) { log.error(`No visual plan for job ${jobId}`); return false; }

  const idea = db.select().from(schema.ideas).where(eq(schema.ideas.id, job.ideaId)).get();
  const jobAssetBase = join(DATA_DIR, `assets/job-${jobId}`);
  const shots = visualPlan.shots as ShotPlan[];
  const jobAssets = db.select().from(schema.assets).where(eq(schema.assets.jobId, jobId)).all();
  const videoFormat = job.videoFormat ?? "short_form";

  const issues: string[] = [];
  const warnings: string[] = [];

  // 1. Check portrait image
  if (idea?.playerId) {
    const player = db.select().from(schema.players).where(eq(schema.players.id, idea.playerId)).get();
    if (player) {
      const portraitPath = join(jobAssetBase, "images", `${player.slug}-portrait.jpg`);
      if (!existsSync(portraitPath)) {
        issues.push(`MISSING portrait: images/${player.slug}-portrait.jpg (used in hook + thumbnails)`);
      }
    }
  }

  // 2. Check voiceover audio
  const audioAsset = jobAssets.find(a => a.type === "audio");
  if (!audioAsset || !existsSync(audioAsset.filePath)) {
    issues.push("MISSING voiceover audio — run voiceover.ts first");
  }

  // 3. Check each shot's media
  for (const shot of shots) {
    if (shot.type === "ai_video") {
      const asset = jobAssets.find(a => a.shotId === shot.id);
      const brollPath = join(jobAssetBase, "broll", `${shot.id}.mp4`);
      const hasSrc = shot.src || (asset && existsSync(asset.filePath)) || existsSync(brollPath);
      if (!hasSrc) {
        issues.push(`MISSING media: ${shot.id} (ai_video) — no broll clip registered`);
      } else {
        // Check resolution
        const filePath = asset?.filePath ?? brollPath;
        if (existsSync(filePath)) {
          try {
            const probe = execSync(
              `ffprobe -v quiet -show_entries stream=width,height -of csv=p=0:s=x "${filePath}"`,
              { encoding: "utf-8" }
            ).trim();
            const [w, h] = probe.split("x").map(Number);
            if (w && h && w < 720 && h < 720) {
              warnings.push(`LOW RES: ${shot.id} — ${w}x${h} (recommend >= 720p)`);
            }
          } catch { /* skip probe failures */ }
        }
      }
    }

    if (shot.type === "text_card") {
      if (!shot.backgroundClip) {
        issues.push(`MISSING backgroundClip: ${shot.id} (text_card will be black screen)`);
      } else {
        const clipPath = join(jobAssetBase, shot.backgroundClip);
        if (!existsSync(clipPath)) {
          issues.push(`FILE NOT FOUND: ${shot.id} — ${shot.backgroundClip}`);
        } else {
          // Check resolution
          try {
            const probe = execSync(
              `ffprobe -v quiet -show_entries stream=width,height -of csv=p=0:s=x "${clipPath}"`,
              { encoding: "utf-8" }
            ).trim();
            const [w, h] = probe.split("x").map(Number);
            if (w && h && w < 720 && h < 720) {
              warnings.push(`LOW RES: ${shot.id} — ${w}x${h} (recommend >= 720p)`);
            }
          } catch { /* skip */ }
        }
      }
    }

    if (shot.type === "still_image") {
      const asset = jobAssets.find(a => a.shotId === shot.id);
      const imgPath = shot.imageSrc ? join(jobAssetBase, shot.imageSrc) : null;
      if (!asset && (!imgPath || !existsSync(imgPath))) {
        issues.push(`MISSING image: ${shot.id} (still_image) — no file found`);
      }
    }
  }

  // 4. Shot count check
  if (videoFormat === "short_form" && shots.length > 15) {
    const avgDuration = shots.reduce((s, sh) => s + sh.durationMs, 0) / shots.length / 1000;
    warnings.push(`HIGH SHOT COUNT: ${shots.length} shots — avg ${avgDuration.toFixed(1)}s each (aim for 10-13 for 5-7s each)`);
  }

  // 5. Check voiceover duration vs shot durations
  if (audioAsset?.durationMs) {
    const totalShotMs = shots.reduce((s, sh) => s + sh.durationMs, 0);
    const ratio = totalShotMs / audioAsset.durationMs;
    if (ratio < 0.5 || ratio > 2.0) {
      warnings.push(`DURATION MISMATCH: shot total ${(totalShotMs/1000).toFixed(0)}s vs voiceover ${(audioAsset.durationMs/1000).toFixed(0)}s (auto-scaling will handle, but ${ratio.toFixed(1)}x is extreme)`);
    }
  }

  // Print results
  console.log(`\nPreflight Check — Job ${jobId} (${videoFormat})\n`);

  if (issues.length === 0 && warnings.length === 0) {
    console.log("  All checks passed. Ready to render.\n");
    return true;
  }

  if (issues.length > 0) {
    console.log(`ERRORS (${issues.length}):`);
    for (const issue of issues) console.log(`  [x] ${issue}`);
    console.log();
  }

  if (warnings.length > 0) {
    console.log(`WARNINGS (${warnings.length}):`);
    for (const warn of warnings) console.log(`  [!] ${warn}`);
    console.log();
  }

  if (issues.length > 0) {
    console.log("Fix the errors above before rendering.\n");
    return false;
  }

  return true;
}
```

**Step 2: Add `--preflight` flag and auto-run before render**

Add flag parsing alongside `previewMode`:

```ts
const preflightOnly = args.includes("--preflight");
const skipPreflight = args.includes("--no-preflight");
```

Add early return for `--preflight`:

```ts
if (preflightOnly) {
  const ok = runPreflight(jobId);
  process.exit(ok ? 0 : 1);
}
```

Add auto-preflight before the render starts (right before the `videoFormat` check for long_form vs short_form rendering):

```ts
// Auto-run preflight before render (skip with --no-preflight)
if (!skipPreflight) {
  const ok = runPreflight(jobId);
  if (!ok) {
    log.error("Preflight failed — fix errors above or use --no-preflight to skip");
    process.exit(1);
  }
}
```

**Step 3: Verify**

Run: `npx tsx packages/pipeline/src/render.ts --job 9 --preflight`
Expected: Checklist output showing all shots have media. Exit code 0.

**Step 4: Commit**

```bash
git add packages/pipeline/src/render.ts
git commit -m "feat: add --preflight asset validation gate before render"
```

---

## Task 3: Fix `b-roll.ts --register` to Update Visual Plan `src`

Currently `--register` copies the file and inserts an asset record but does NOT set `src` on the `ai_video` shot in the visual plan. This forces manual SQL every time.

**Files:**
- Modify: `packages/pipeline/src/b-roll.ts`

**Step 1: Update `registerFile()` to set `src` on the visual plan shot**

In `b-roll.ts`, find the `registerFile` function. After the existing `db.insert(schema.assets)` block (line 200-208), add the visual plan update — same pattern as `registerHighlight`:

```ts
  // Update the shot's src in the visual plan (same pattern as registerHighlight)
  const relativePath = `broll/${shotId}.${ext}`;
  shot.src = relativePath;
  getSqlite().prepare("UPDATE visual_plans SET shots = ? WHERE job_id = ?").run(
    JSON.stringify(shots),
    jobId
  );
```

Also update the log message to show the relative path:

```ts
  log.info(`Registered B-roll: ${shotId} -> ${destFile}`, { jobId });
  console.log(`Registered ${shotId}: ${relativePath} (visual plan updated)`);
```

**Step 2: Add `src` field to ShotPlan interface**

In `packages/shared/src/types/visual-plan.ts`, add after the `backgroundClip` field (line 47):

```ts
  // B-roll source for ai_video shots (set by b-roll.ts --register)
  src?: string;
```

**Step 3: Update `visual-plan.ts` validate() to pass through `src`**

In `visual-plan.ts`, add `src` to the shot construction object (after the `backgroundClip` line, around line 72):

```ts
      src: s.src as string | undefined,
```

**Step 4: Verify**

Run: `npx tsx packages/pipeline/src/b-roll.ts --job 9 --list`
Expected: Shows ai_video shots with their current status. The `--register` command will now update the visual plan.

**Step 5: Commit**

```bash
git add packages/pipeline/src/b-roll.ts packages/shared/src/types/visual-plan.ts packages/pipeline/src/visual-plan.ts
git commit -m "fix: b-roll --register now updates visual plan src field"
```

---

## Task 4: Download Verification (`b-roll.ts --verify`)

Shows a thumbnail grid and metadata for all registered clips so you can visually verify the right content was downloaded (catches the "wrong interview video" problem).

**Files:**
- Modify: `packages/pipeline/src/b-roll.ts`

**Step 1: Add `verifyClips()` function**

Add before the `main()` function:

```ts
function verifyClips(jobId: number): void {
  const db = getDb();
  const visualPlan = db.select().from(schema.visualPlans).where(eq(schema.visualPlans.jobId, jobId)).get();
  if (!visualPlan) { log.error(`No visual plan for job ${jobId}`); process.exit(1); }

  const shots = visualPlan.shots as ShotPlan[];
  const jobAssetBase = join(DATA_DIR, `assets/job-${jobId}`);
  const verifyDir = join(jobAssetBase, "verify");
  ensureDir(verifyDir);

  console.log(`\nVerifying clips for Job ${jobId}:\n`);

  let hasIssues = false;

  for (const shot of shots) {
    let clipPath: string | undefined;
    let clipType: string;

    if (shot.type === "ai_video") {
      clipPath = shot.src ? join(jobAssetBase, shot.src) : join(jobAssetBase, "broll", `${shot.id}.mp4`);
      clipType = "broll";
    } else if (shot.type === "text_card" && shot.backgroundClip) {
      clipPath = join(jobAssetBase, shot.backgroundClip);
      clipType = "highlight";
    } else {
      continue; // Skip still_image, timeline, badge_reveal
    }

    if (!clipPath || !existsSync(clipPath)) {
      console.log(`  [MISSING] ${shot.id} (${shot.type}) — no file`);
      hasIssues = true;
      continue;
    }

    // Extract thumbnail at 1s into the clip
    const thumbPath = join(verifyDir, `${shot.id}.jpg`);
    try {
      execSync(
        `ffmpeg -y -ss 1 -i "${clipPath}" -vframes 1 -q:v 3 "${thumbPath}"`,
        { stdio: "pipe", timeout: 10000 }
      );
    } catch {
      // Try at 0s if 1s fails (very short clips)
      try {
        execSync(
          `ffmpeg -y -ss 0 -i "${clipPath}" -vframes 1 -q:v 3 "${thumbPath}"`,
          { stdio: "pipe", timeout: 10000 }
        );
      } catch { /* give up */ }
    }

    // Get resolution and duration
    let resolution = "unknown";
    let duration = "unknown";
    try {
      const probe = execSync(
        `ffprobe -v quiet -show_entries stream=width,height -show_entries format=duration -of csv=p=0 "${clipPath}"`,
        { encoding: "utf-8" }
      ).trim();
      const lines = probe.split("\n");
      if (lines[0]) resolution = lines[0].replace(",", "x");
      if (lines[1]) duration = `${parseFloat(lines[1]).toFixed(1)}s`;
    } catch { /* skip */ }

    const thumbExists = existsSync(thumbPath);
    const marker = thumbExists ? "[OK]" : "[!]";
    console.log(`  ${marker} ${shot.id} (${clipType}) — ${resolution}, ${duration}`);
    if (thumbExists) {
      console.log(`      thumbnail: ${thumbPath}`);
    }
  }

  console.log(`\nThumbnails saved to: ${verifyDir}/`);
  console.log("Open the folder to visually verify each clip shows the correct content.\n");

  if (hasIssues) {
    console.log("Some clips are missing — register them before rendering.\n");
  }
}
```

Add the `execSync` import if not already present (it's not in b-roll.ts currently):

```ts
import { execSync } from "child_process";
```

**Step 2: Add --verify to CLI routing in main()**

In the `main()` function, add a new branch before the existing `--list-highlights` check:

```ts
  if (args.includes("--verify")) {
    verifyClips(jobId);
  } else if (args.includes("--list-highlights")) {
```

Also update the usage text to include `--verify`.

**Step 3: Verify**

Run: `npx tsx packages/pipeline/src/b-roll.ts --job 9 --verify`
Expected: Lists all clips with resolution/duration and creates thumbnail JPGs in `data/assets/job-9/verify/`.

**Step 4: Commit**

```bash
git add packages/pipeline/src/b-roll.ts
git commit -m "feat: add --verify to b-roll.ts — thumbnail + metadata check for all clips"
```

---

## Task 5: Asset Status Dashboard (`assets.ts --status`)

Single-command checklist showing every shot's media status, file resolution, and portrait image. Replaces ad-hoc DB queries and manual file checks.

**Files:**
- Modify: `packages/pipeline/src/assets.ts`

**Step 1: Add `showStatus()` function**

Add before `main()` in assets.ts:

```ts
import { execSync } from "child_process";

function showStatus(jobId: number): void {
  const db = getDb();
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (!job) { log.error(`Job ${jobId} not found`); process.exit(1); }

  const visualPlan = db.select().from(schema.visualPlans).where(eq(schema.visualPlans.jobId, jobId)).get();
  if (!visualPlan) { log.error(`No visual plan for job ${jobId}`); process.exit(1); }

  const idea = db.select().from(schema.ideas).where(eq(schema.ideas.id, job.ideaId)).get();
  const shots = visualPlan.shots as ShotPlan[];
  const jobAssets = db.select().from(schema.assets).where(eq(schema.assets.jobId, jobId)).all();
  const jobAssetBase = join(DATA_DIR, `assets/job-${jobId}`);
  const videoFormat = job.videoFormat ?? "short_form";

  function probeResolution(filePath: string): string {
    try {
      const probe = execSync(
        `ffprobe -v quiet -show_entries stream=width,height -of csv=p=0:s=x "${filePath}"`,
        { encoding: "utf-8" }
      ).trim();
      return probe || "?";
    } catch { return "?"; }
  }

  function probeDuration(filePath: string): string {
    try {
      const d = execSync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
        { encoding: "utf-8" }
      ).trim();
      return d ? `${parseFloat(d).toFixed(1)}s` : "?";
    } catch { return "?"; }
  }

  console.log(`\nAsset Status — Job ${jobId} (${videoFormat})\n`);
  console.log("SHOTS:");

  let ready = 0;
  let missing = 0;

  for (const shot of shots) {
    let status: string;
    let mediaInfo = "";

    if (shot.type === "ai_video") {
      const asset = jobAssets.find(a => a.shotId === shot.id);
      const brollPath = join(jobAssetBase, "broll", `${shot.id}.mp4`);
      const srcPath = shot.src ? join(jobAssetBase, shot.src) : null;
      const filePath = (srcPath && existsSync(srcPath)) ? srcPath
        : (asset?.filePath && existsSync(asset.filePath)) ? asset.filePath
        : existsSync(brollPath) ? brollPath : null;

      if (filePath) {
        status = "[OK]";
        mediaInfo = `${probeResolution(filePath)}, ${probeDuration(filePath)}`;
        ready++;
      } else {
        status = "[MISSING]";
        mediaInfo = "no broll clip";
        missing++;
      }
    } else if (shot.type === "text_card") {
      if (shot.backgroundClip) {
        const clipPath = join(jobAssetBase, shot.backgroundClip);
        if (existsSync(clipPath)) {
          status = "[OK]";
          mediaInfo = `${shot.backgroundClip} (${probeResolution(clipPath)}, ${probeDuration(clipPath)})`;
          ready++;
        } else {
          status = "[FILE MISSING]";
          mediaInfo = shot.backgroundClip;
          missing++;
        }
      } else {
        status = "[NO CLIP]";
        mediaInfo = "will be black screen";
        missing++;
      }
    } else if (shot.type === "still_image") {
      const asset = jobAssets.find(a => a.shotId === shot.id);
      const imgPath = shot.imageSrc ? join(jobAssetBase, shot.imageSrc) : null;
      if (asset && existsSync(asset.filePath)) {
        status = "[OK]";
        mediaInfo = asset.filePath.split("/").pop() ?? "";
        ready++;
      } else if (imgPath && existsSync(imgPath)) {
        status = "[OK]";
        mediaInfo = shot.imageSrc!;
        ready++;
      } else {
        status = "[MISSING]";
        mediaInfo = "no image file";
        missing++;
      }
    } else {
      status = "[OK]";
      mediaInfo = shot.type;
      ready++;
    }

    console.log(`  ${status.padEnd(14)} ${shot.id.padEnd(20)} ${shot.type.padEnd(14)} ${mediaInfo}`);
  }

  // Portrait check
  console.log("\nPORTRAIT:");
  if (idea?.playerId) {
    const player = db.select().from(schema.players).where(eq(schema.players.id, idea.playerId)).get();
    if (player) {
      const portraitPath = join(jobAssetBase, "images", `${player.slug}-portrait.jpg`);
      if (existsSync(portraitPath)) {
        console.log(`  [OK]            images/${player.slug}-portrait.jpg`);
      } else {
        console.log(`  [MISSING]       images/${player.slug}-portrait.jpg (needed for hook + thumbnails)`);
        missing++;
      }
    }
  }

  // Voiceover check
  console.log("\nVOICEOVER:");
  const audioAsset = jobAssets.find(a => a.type === "audio");
  if (audioAsset && existsSync(audioAsset.filePath)) {
    console.log(`  [OK]            ${audioAsset.filePath.split("/").pop()} (${(audioAsset.durationMs! / 1000).toFixed(1)}s)`);
  } else {
    console.log("  [MISSING]       no voiceover audio");
    missing++;
  }

  // Summary
  const total = shots.length;
  console.log(`\nSUMMARY: ${ready}/${total} shots ready, ${missing} issues\n`);

  if (missing > 0) {
    process.exit(1);
  }
}
```

**Step 2: Add --status to CLI routing**

In `main()`, add before the existing flow:

```ts
  if (args.includes("--status")) {
    showStatus(jobId);
    return;
  }
```

Add necessary imports at top if missing: `execSync` from `child_process`, `ShotPlan` type, `schema`, `existsSync`.

**Step 3: Verify**

Run: `npx tsx packages/pipeline/src/assets.ts --job 9 --status`
Expected: Clean checklist of all shots with resolution/duration info.

**Step 4: Commit**

```bash
git add packages/pipeline/src/assets.ts
git commit -m "feat: add --status dashboard to assets.ts — full asset checklist"
```

---

## Task 6: Visual Plan Shot Count Guardrails

Warn when short-form plans have too many shots (each would be too short) and suggest which to cut.

**Files:**
- Modify: `packages/pipeline/src/visual-plan.ts`

**Step 1: Add shot count validation to the `validate()` function**

After the existing long-form validation block (after line 86), add short-form validation:

```ts
  if (videoFormat === "short_form") {
    if (shots.length > 15) {
      const avgSec = shots.reduce((s, sh) => s + sh.durationMs, 0) / shots.length / 1000;
      log.warn(`Short-form plan has ${shots.length} shots — avg ${avgSec.toFixed(1)}s each. Aim for 10-13 shots (5-7s each) to avoid slideshow effect.`);

      // Suggest cuts: identify shots that could be merged or removed
      const sectionCounts = new Map<string, number>();
      for (const s of shots) {
        sectionCounts.set(s.sectionId, (sectionCounts.get(s.sectionId) ?? 0) + 1);
      }
      const heavySections = [...sectionCounts.entries()]
        .filter(([, count]) => count > 3)
        .sort((a, b) => b[1] - a[1]);

      if (heavySections.length > 0) {
        log.warn(`Sections with most shots: ${heavySections.map(([id, n]) => `${id}(${n})`).join(", ")} — consider trimming these first`);
      }
    }

    // Warn about potential still-image overload
    const stillCount = shots.filter(s => s.type === "still_image").length;
    if (stillCount > 3) {
      log.warn(`${stillCount} still_image shots — aim for 2-3 max. Replace extras with text_card + backgroundClip or ai_video for more visual energy.`);
    }
  }
```

**Step 2: Verify**

Test with a 18-shot plan (pipe JSON to stdin):
Run: `echo '[...]' | npx tsx packages/pipeline/src/visual-plan.ts --write 9 --stdin`
Expected: Warning about high shot count with section suggestions.

**Step 3: Commit**

```bash
git add packages/pipeline/src/visual-plan.ts
git commit -m "feat: add shot count guardrails to visual-plan.ts"
```

---

## Task 7: Props-Only Mode (`render.ts --props-only`)

Generate Remotion props JSON files without rendering. Enables Remotion Studio preview before committing to a full render.

**Files:**
- Modify: `packages/pipeline/src/render.ts`

**Step 1: Add `--props-only` flag**

Add alongside the existing flag parsing:

```ts
const propsOnly = args.includes("--props-only");
```

**Step 2: Add early exit after props generation**

The existing render flow already generates props files before calling `npx remotion render`. We need to add an exit point right after props are written.

For the **short-form path** (inside the `for (const platform of platforms)` loop), add after `writeFileSync(propsPath, ...)`:

```ts
      if (propsOnly) {
        log.info(`Props written: ${propsPath}`, { jobId, platform });
        continue;
      }
```

For the **long-form path**, add after `writeFileSync(propsPath, ...)`:

```ts
    if (propsOnly) {
      log.info(`Props written: ${propsPath}`, { jobId });
      console.log(`\nProps-only mode. To preview in Remotion Studio:`);
      console.log(`  cd packages/remotion && npx remotion studio`);
      console.log(`  Load props from: ${propsPath}\n`);
      return;
    }
```

For short-form, add after the platforms loop:

```ts
    if (propsOnly) {
      console.log(`\nProps-only mode. Generated ${platforms.length} props file(s).`);
      console.log(`To preview in Remotion Studio:`);
      console.log(`  cd packages/remotion && npx remotion studio`);
      console.log(`  Load props from: ${outputDir}/\n`);
      return;
    }
```

**Step 3: Verify**

Run: `npx tsx packages/pipeline/src/render.ts --job 9 --props-only`
Expected: Creates props JSON files in output dir, prints studio instructions, exits without rendering.

**Step 4: Commit**

```bash
git add packages/pipeline/src/render.ts
git commit -m "feat: add --props-only mode to render.ts for Remotion Studio preview"
```

---

## Summary of All New CLI Flags

| Module | Flag | Purpose |
|--------|------|---------|
| `render.ts` | `--preview` | One JPEG per shot (~10s) — visual spot-check |
| `render.ts` | `--preflight` | Asset validation checklist (auto-runs before render) |
| `render.ts` | `--no-preflight` | Skip the auto-preflight |
| `render.ts` | `--props-only` | Generate props JSON without rendering |
| `b-roll.ts` | `--register` | Now also updates visual plan `src` (was broken) |
| `b-roll.ts` | `--verify` | Thumbnail + metadata check for all clips |
| `assets.ts` | `--status` | Full asset dashboard with resolution/duration |
| `visual-plan.ts` | (auto) | Warns on >15 shots or >3 still_images for short-form |

## Recommended Workflow After Implementation

```bash
# 1. Write visual plan (auto-warns on shot count)
echo '...' | npx tsx packages/pipeline/src/visual-plan.ts --write 9 --stdin

# 2. Register assets (now auto-updates visual plan)
npx tsx packages/pipeline/src/b-roll.ts --job 9 --register hook-portrait --file clip.mp4

# 3. Check asset status dashboard
npx tsx packages/pipeline/src/assets.ts --job 9 --status

# 4. Verify clips are correct content
npx tsx packages/pipeline/src/b-roll.ts --job 9 --verify

# 5. Quick visual preview (~10s)
npx tsx packages/pipeline/src/render.ts --job 9 --preview

# 6. Full render (auto-preflight runs first)
npx tsx packages/pipeline/src/render.ts --job 9
```
