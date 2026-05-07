const oracledb = require("oracledb");
require("dotenv").config();

async function run() {
  try {
    console.log("🚀 FINAL Node.js TLS Attempt...");
    
    const user = process.env.ORACLE_USER || "ADMIN";
    const password = process.env.ORACLE_PASSWORD;
    
    // EXACT same string as Python success
    const dsn = "(description= (retry_count=20)(retry_delay=3)(address=(protocol=tcps)(port=1522)(host=adb.ap-singapore-1.oraclecloud.com))(connect_data=(service_name=gba4ef248f7791d_codeatlasdatabase_low.adb.oraclecloud.com))(security=(ssl_server_dn_match=yes)))";

    console.log("Using User:", user);

    const connection = await oracledb.getConnection({
      user: user,
      password: password,
      connectString: dsn
    });

    console.log("✅ FINALLY! Node.js connected via TLS!");
    const result = await connection.execute("SELECT TO_CHAR(sysdate, 'YYYY-MM-DD HH24:MI:SS') as now FROM dual");
    console.log("Database Time:", result.rows[0][0]);
    await connection.close();
  } catch (err) {
    console.error("❌ Node.js is being difficult:", err.message);
  }
}

run();
