import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb, closeDb } from "./connection.js";

const db = getDb();
console.log("Running migrations...");
migrate(db, { migrationsFolder: "drizzle" });
console.log("Migrations complete.");
closeDb();
