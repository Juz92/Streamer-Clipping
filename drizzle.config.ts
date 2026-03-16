import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./packages/shared/src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_PATH || "data/ltx.db",
  },
});
