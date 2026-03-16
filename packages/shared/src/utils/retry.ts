import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/connection.js";
import type { JobState } from "../types/job-states.js";

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  jobId?: number;
}

export async function withPipelineRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, jobId } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        if (jobId) {
          const db = getDb();
          const job = db
            .select()
            .from(schema.jobs)
            .where(eq(schema.jobs.id, jobId))
            .get();
          if (job) {
            db.update(schema.jobs)
              .set({
                state: "failed" as JobState,
                retryFromState: job.state,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(schema.jobs.id, jobId))
              .run();
          }
        }
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Unreachable");
}
