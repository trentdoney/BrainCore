import postgres from "postgres";
import { config } from "./config";

export const sql = postgres(config.postgres.dsn, {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
});

export async function testConnection(): Promise<boolean> {
  try {
    const [{ now }] = await sql`SELECT now()`;
    console.log(`Connected to PostgreSQL: ${now}`);
    return true;
  } catch (e) {
    console.error("PostgreSQL connection failed:", e);
    return false;
  }
}
