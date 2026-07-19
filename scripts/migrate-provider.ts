import { createPool } from "oracledb";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const pool = await createPool({
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectionString: process.env.ORACLE_CONN_STRING,
  });
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `ALTER TABLE ai_dreaming_memory ADD (provider VARCHAR2(255) DEFAULT NULL)`
    );
    console.log("[Migration] Column `provider` added successfully.");
  } catch (e: any) {
    if (e.errorNum === 1430) {
      console.log("[Migration] Column `provider` already exists.");
    } else {
      throw e;
    }
  } finally {
    await conn.close();
    await pool.close();
  }
}

main().catch((e) => {
  console.error("[Migration] Failed:", e.message);
  process.exit(1);
});
