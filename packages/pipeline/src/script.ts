import { getDb, closeDb, schema, createLogger, advanceState, toJobState, readStdin } from "@ltx/shared";
import type { ScriptPackage, ScriptSection } from "@ltx/shared";
import { eq } from "drizzle-orm";

const log = createLogger("script");

function validate(data: unknown): ScriptPackage {
  const pkg = data as Record<string, unknown>;
  if (!pkg.hookText || typeof pkg.hookText !== "string") {
    throw new Error("Missing or invalid hookText");
  }
  if (!Array.isArray(pkg.sections) || pkg.sections.length === 0) {
    throw new Error("Missing or empty sections array");
  }
  const sections: ScriptSection[] = [];
  for (const raw of pkg.sections as Record<string, unknown>[]) {
    if (!raw.id || !raw.heading || !raw.narration) {
      throw new Error(`Section missing required fields: ${JSON.stringify(raw)}`);
    }
    sections.push({
      id: raw.id as string,
      heading: raw.heading as string,
      narration: raw.narration as string,
      visualNotes: (raw.visualNotes as string) || "",
      durationEstimateSec: (raw.durationEstimateSec as number) || 0,
    });
  }
  if (!pkg.fullNarration || typeof pkg.fullNarration !== "string") {
    throw new Error("Missing or invalid fullNarration");
  }
  if (!pkg.youtubeTitle || typeof pkg.youtubeTitle !== "string") {
    throw new Error("Missing or invalid youtubeTitle");
  }
  if (!pkg.youtubeDescription || typeof pkg.youtubeDescription !== "string") {
    throw new Error("Missing or invalid youtubeDescription");
  }
  if (!Array.isArray(pkg.youtubeTags)) {
    throw new Error("Missing or invalid youtubeTags array");
  }
  return {
    hookText: pkg.hookText as string,
    sections,
    fullNarration: pkg.fullNarration as string,
    youtubeTitle: pkg.youtubeTitle as string,
    youtubeDescription: pkg.youtubeDescription as string,
    youtubeTags: pkg.youtubeTags as string[],
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.includes("--write") || !args.includes("--stdin")) {
    console.log("Usage: script.ts --write <job-id> --stdin");
    console.log("Reads ScriptPackage JSON from stdin, validates, writes to DB.");
    process.exit(1);
  }

  const jobIdIdx = args.indexOf("--write") + 1;
  const jobId = parseInt(args[jobIdIdx], 10);
  if (isNaN(jobId)) {
    log.error("Invalid job ID");
    process.exit(1);
  }

  const db = getDb();
  const job = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
  if (!job) {
    log.error(`Job ${jobId} not found`);
    process.exit(1);
  }

  const raw = await readStdin();

  let scriptPkg: ScriptPackage;
  try {
    scriptPkg = validate(JSON.parse(raw));
  } catch (e) {
    log.error(`Validation failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const existing = db
    .select()
    .from(schema.scripts)
    .where(eq(schema.scripts.jobId, jobId))
    .get();

  if (existing) {
    db.update(schema.scripts)
      .set({
        hookText: scriptPkg.hookText,
        sections: scriptPkg.sections,
        fullNarration: scriptPkg.fullNarration,
        youtubeTitle: scriptPkg.youtubeTitle,
        youtubeDescription: scriptPkg.youtubeDescription,
        youtubeTags: scriptPkg.youtubeTags,
      })
      .where(eq(schema.scripts.jobId, jobId))
      .run();
    log.info(`Script updated for job ${jobId}`, { jobId, title: scriptPkg.youtubeTitle });
  } else {
    db.insert(schema.scripts)
      .values({
        jobId,
        hookText: scriptPkg.hookText,
        sections: scriptPkg.sections,
        fullNarration: scriptPkg.fullNarration,
        youtubeTitle: scriptPkg.youtubeTitle,
        youtubeDescription: scriptPkg.youtubeDescription,
        youtubeTags: scriptPkg.youtubeTags,
      })
      .run();
    log.info(`Script saved for job ${jobId}`, { jobId, title: scriptPkg.youtubeTitle });
  }

  const currentState = toJobState(job.state);
  if (currentState !== "scripted") {
    const newState = advanceState(currentState, "scripted");
    db.update(schema.jobs)
      .set({ state: newState, updatedAt: new Date().toISOString() })
      .where(eq(schema.jobs.id, jobId))
      .run();
  }
}

process.on("exit", closeDb);

main().catch((e) => {
  log.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
