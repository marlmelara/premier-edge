import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/env";
import * as schema from "./schema";

// postgres.js works against both local Docker Postgres and Neon's pooled
// connection string. Created lazily so importing this module during
// `next build` doesn't require a database.
let _db: PostgresJsDatabase<typeof schema> | undefined;

export function getDb() {
  _db ??= drizzle(postgres(env().DATABASE_URL, { prepare: false }), { schema });
  return _db;
}

export type Db = PostgresJsDatabase<typeof schema>;
export { schema };
