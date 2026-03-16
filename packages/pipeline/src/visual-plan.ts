import { getDb, closeDb, schema, createLogger, advanceState, toJobState, readStdin } from "@ltx/shared";
import type { ShotPlan } from "@ltx/shared";
import { eq } from "drizzle-orm";

const log = createLogger("visual-plan");

function validate(data: unknown): ShotPlan[] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Expected non-empty JSON array of shots");
  }
  const shots: ShotPlan[] = [];
  for (const raw of data) {
    const s = raw as Record<string, unknown>;
    if (!s.id || typeof s.id !== "string") {
      throw new Error("Shot missing id");
    }
    if (!s.sectionId || typeof s.sectionId !== "string") {
      throw new Error(`Shot ${s.id} missing sectionId`);
    }
    const validTypes = ["screenshot", "browser_recording", "text_card"] as const;
    if (!validTypes.includes(s.type as typeof validTypes[number])) {
      throw new Error(`Shot ${s.id} has invalid type: ${s.type}`);
    }
    if ((s.type === "screenshot" || s.type === "browser_recording") && !s.url) {
      throw new Error(`Shot ${s.id} of type ${s.type} requires a url`);
    }
    if (!s.durationMs || typeof s.durationMs !== "number") {
      throw new Error(`Shot ${s.id} missing or invalid durationMs`);
    }
    shots.push({
      id: s.id,
      sectionId: s.sectionId,
      type: s.type as ShotPlan["type"],
      url: s.url as string | undefined,
      selector: s.selector as string | undefined,
      scrollTo: s.scrollTo as string | undefined,
      clickSequence: s.clickSequence as string[] | undefined,
      durationMs: s.durationMs,
      caption: s.caption as string | undefined,
      textContent: s.textContent as string | undefined,
      kenBurns: s.kenBurns as ShotPlan["kenBurns"],
    });
  }
  return shots;
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.includes("--write") || !args.includes("--stdin")) {
    console.log("Usage: visual-plan.ts --write <job-id> --stdin");
    console.log("Reads ShotPlan[] JSON from stdin, validates, writes to DB.");
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

  let shots: ShotPlan[];
  try {
    shots = validate(JSON.parse(raw));
  } catch (e) {
    log.error(`Validation failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const existing = db
    .select()
    .from(schema.visualPlans)
    .where(eq(schema.visualPlans.jobId, jobId))
    .get();

  if (existing) {
    db.update(schema.visualPlans)
      .set({ shots })
      .where(eq(schema.visualPlans.jobId, jobId))
      .run();
    log.info(`Visual plan updated for job ${jobId}: ${shots.length} shots`, { jobId });
  } else {
    db.insert(schema.visualPlans)
      .values({ jobId, shots })
      .run();
    log.info(`Visual plan saved for job ${jobId}: ${shots.length} shots`, { jobId });
  }

  const currentState = toJobState(job.state);
  if (currentState !== "visual_planned") {
    const newState = advanceState(currentState, "visual_planned");
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
