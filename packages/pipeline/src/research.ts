import { getDb, closeDb, schema, hashUrl, createLogger, readStdin } from "@ltx/shared";
import { eq } from "drizzle-orm";

const log = createLogger("research");

interface IdeaInput {
  title: string;
  summary: string;
  sourceUrl: string;
  sourceName: string;
  noveltyScore?: number;
  impactScore?: number;
  audienceScore?: number;
  compositeScore?: number;
}

async function main() {
  const args = process.argv.slice(2);

  if (!args.includes("--write")) {
    console.log("Usage: research.ts --write < ideas.json");
    console.log("Reads JSON array of ideas from stdin, dedup-checks, inserts into DB.");
    process.exit(1);
  }

  const raw = await readStdin();

  let ideas: IdeaInput[];
  try {
    ideas = JSON.parse(raw);
    if (!Array.isArray(ideas)) {
      throw new Error("Expected JSON array");
    }
  } catch (e) {
    log.error(`Invalid JSON input: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const db = getDb();
  let inserted = 0;
  let skipped = 0;

  for (const idea of ideas) {
    if (!idea.title || !idea.sourceUrl || !idea.sourceName) {
      log.warn("Skipping idea with missing required fields", { title: idea.title });
      skipped++;
      continue;
    }

    const urlHash = hashUrl(idea.sourceUrl);

    const existing = db
      .select()
      .from(schema.ideas)
      .where(eq(schema.ideas.sourceUrlHash, urlHash))
      .get();

    if (existing) {
      log.info(`Duplicate skipped: ${idea.title}`, { sourceUrl: idea.sourceUrl });
      skipped++;
      continue;
    }

    const composite =
      idea.compositeScore ??
      ((idea.noveltyScore ?? 0) + (idea.impactScore ?? 0) + (idea.audienceScore ?? 0)) / 3;

    db.insert(schema.ideas)
      .values({
        title: idea.title,
        summary: idea.summary || "",
        sourceUrl: idea.sourceUrl,
        sourceUrlHash: urlHash,
        sourceName: idea.sourceName,
        noveltyScore: idea.noveltyScore ?? 0,
        impactScore: idea.impactScore ?? 0,
        audienceScore: idea.audienceScore ?? 0,
        compositeScore: composite,
        status: "new",
      })
      .run();

    log.info(`Inserted: ${idea.title}`, { compositeScore: composite });
    inserted++;
  }

  log.info(`Done: ${inserted} inserted, ${skipped} skipped`);
}

process.on("exit", closeDb);

main().catch((e) => {
  log.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
