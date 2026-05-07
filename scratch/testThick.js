const oracledb = require("oracledb");
require("dotenv").config();

async function run() {
  try {
    console.log("🚀 Testing Oracle Connection in THICK MODE...");
    
    // Initialize client for Thick Mode
    oracledb.initOracleClient({ 
      libDir: process.env.ORACLE_LIB_DIR,
      configDir: process.env.ORACLE_WALLET_DIR
    });

    const user = process.env.ORACLE_USER || "ADMIN";
    const password = process.env.ORACLE_PASSWORD;
    const connectString = process.env.ORACLE_CONN_STRING;

    console.log("Using User:", user);
    console.log("Lib Dir:", process.env.ORACLE_LIB_DIR);

    const connection = await oracledb.getConnection({
      user: user,
      password: password,
      connectString: connectString
    });

    console.log("✅ SUCCESS! Connected in Thick Mode!");
    const result = await connection.execute("SELECT TO_CHAR(sysdate, 'YYYY-MM-DD HH24:MI:SS') as now FROM dual");
    console.log("Database Time:", result.rows[0][0]);
    await connection.close();
  } catch (err) {
    console.error("❌ Thick Mode failed:", err.message);
  }
}

run();
