import oracledb from "oracledb";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

async function run() {
  try {
    // Initialize client with wallet
    oracledb.initOracleClient({ 
      configDir: path.join(process.cwd(), "wallet") 
    });

    const connection = await oracledb.getConnection({
      user: process.env.ORACLE_USER || "admin",
      password: process.env.ORACLE_PASSWORD || "",
      connectString: "codeatlasdatabase_high"
    });

    console.log("Successfully connected to Oracle Database!");
    
    const result = await connection.execute("SELECT sysdate FROM dual");
    console.log("Current DB Time:", result.rows);

    await connection.close();
  } catch (err) {
    console.error("Connection failed:", err);
  }
}

run();
