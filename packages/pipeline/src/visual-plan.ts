import { getDb, schema, createLogger, advanceState } from "@ltx/shared";
import type { ShotPlan } from "@ltx/shared";
import { eq } from "drizzle-orm";

const log = createLogger("visual-plan");

function validate(data: unknown): ShotPlan[] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Expected non-empty JSON array of shots");
  }
  for (const shot of data) {
    const s = shot as Record<string, unknown>;
    if (!s.id || typeof s.id !== "string") {
      throw new Error("Shot missing id");
    }
    if (!s.sectionId || typeof s.sectionId !== "string") {
      throw new Error(`Shot ${s.id} missing sectionId`);
    }
    if (!["screenshot", "browser_recording", "text_card"].includes(s.type as string)) {
      throw new Error(`Shot ${s.id} has invalid type: ${s.type}`);
    }
    if ((s.type === "screenshot" || s.type === "browser_recording") && !s.url) {
      throw new Error(`Shot ${s.id} of type ${s.type} requires a url`);
    }
    if (!s.durationMs || typeof s.durationMs !== "number") {
      throw new Error(`Shot ${s.id} missing or invalid durationMs`);
    }
  }
  return data as ShotPlan[];
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

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();

  let shots: ShotPlan[];
  try {
    shots = validate(JSON.parse(raw));
  } catch (e) {
    log.error(`Validation failed: ${(e as Error).message}`);
    process.exit(1);
  }

  db.insert(schema.visualPlans)
    .values({
      jobId,
      shots,
    })
    .run();

  const newState = advanceState(job.state as any, "visual_planned");
  db.update(schema.jobs)
    .set({ state: newState, updatedAt: new Date().toISOString() })
    .where(eq(schema.jobs.id, jobId))
    .run();

  log.info(`Visual plan saved for job ${jobId}: ${shots.length} shots`, { jobId });
}

main().catch((e) => {
  log.error(`Fatal: ${e.message}`);
  process.exit(1);
});
