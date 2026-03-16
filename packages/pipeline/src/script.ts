import { getDb, schema, createLogger, advanceState } from "@ltx/shared";
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
  for (const s of pkg.sections as ScriptSection[]) {
    if (!s.id || !s.heading || !s.narration) {
      throw new Error(`Section missing required fields: ${JSON.stringify(s)}`);
    }
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
  return pkg as unknown as ScriptPackage;
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

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();

  let scriptPkg: ScriptPackage;
  try {
    scriptPkg = validate(JSON.parse(raw));
  } catch (e) {
    log.error(`Validation failed: ${(e as Error).message}`);
    process.exit(1);
  }

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

  const newState = advanceState(job.state as any, "scripted");
  db.update(schema.jobs)
    .set({ state: newState, updatedAt: new Date().toISOString() })
    .where(eq(schema.jobs.id, jobId))
    .run();

  log.info(`Script saved for job ${jobId}`, { jobId, title: scriptPkg.youtubeTitle });
}

main().catch((e) => {
  log.error(`Fatal: ${e.message}`);
  process.exit(1);
});
