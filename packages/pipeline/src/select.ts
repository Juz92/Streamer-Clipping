import { getDb, schema, createLogger } from "@ltx/shared";
import { eq, desc, inArray } from "drizzle-orm";

const log = createLogger("select");

function showTop(n: number) {
  const db = getDb();
  const topIdeas = db
    .select()
    .from(schema.ideas)
    .where(eq(schema.ideas.status, "new"))
    .orderBy(desc(schema.ideas.compositeScore))
    .limit(n)
    .all();

  if (topIdeas.length === 0) {
    console.log("No unselected ideas found.");
    return;
  }

  console.log(`\nTop ${topIdeas.length} ideas:\n`);
  for (const idea of topIdeas) {
    console.log(
      `  [${idea.id}] (score: ${idea.compositeScore?.toFixed(1)}) ${idea.title}`
    );
    console.log(`      ${idea.sourceName} — ${idea.sourceUrl}`);
    console.log();
  }
}

const VALID_FORMATS = ["long_form", "short_form"] as const;
type VideoFormat = typeof VALID_FORMATS[number];

function createJobs(idStr: string, format: VideoFormat) {
  const ids = idStr
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
  if (ids.length === 0) {
    log.error("No valid numeric IDs provided");
    process.exit(1);
  }
  const db = getDb();

  const existingIdeas = db
    .select()
    .from(schema.ideas)
    .where(inArray(schema.ideas.id, ids))
    .all();

  if (existingIdeas.length === 0) {
    log.error("No ideas found with those IDs");
    process.exit(1);
  }

  for (const idea of existingIdeas) {
    const existingJob = db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.ideaId, idea.id))
      .get();

    if (existingJob) {
      log.warn(`Job already exists for idea ${idea.id}: job ${existingJob.id}`);
      continue;
    }

    const result = db
      .insert(schema.jobs)
      .values({
        ideaId: idea.id,
        state: "selected",
        videoFormat: format,
      })
      .run();

    db.update(schema.ideas)
      .set({ status: "selected" })
      .where(eq(schema.ideas.id, idea.id))
      .run();

    log.info(`Created job ${result.lastInsertRowid} for idea ${idea.id}: ${idea.title}`, {
      format,
    });
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--show-top")) {
    const idx = args.indexOf("--show-top");
    const n = parseInt(args[idx + 1] || "5", 10);
    showTop(n);
    return;
  }

  if (args.includes("--create-jobs")) {
    const idx = args.indexOf("--create-jobs");
    const idStr = args[idx + 1];
    if (!idStr) {
      log.error("Usage: select.ts --create-jobs <id,id,...> [--format short_form]");
      process.exit(1);
    }
    let format: VideoFormat = "long_form";
    if (args.includes("--format")) {
      const rawFormat = args[args.indexOf("--format") + 1];
      if (!VALID_FORMATS.includes(rawFormat as VideoFormat)) {
        log.error(`Invalid format: ${rawFormat}. Must be one of: ${VALID_FORMATS.join(", ")}`);
        process.exit(1);
      }
      format = rawFormat as VideoFormat;
    }
    createJobs(idStr, format);
    return;
  }

  console.log("Usage:");
  console.log("  select.ts --show-top [N]           Show top N unselected ideas");
  console.log("  select.ts --create-jobs <id,id,...>  Create jobs from idea IDs");
  console.log("  select.ts --create-jobs <id> --format short_form");
}

main();
