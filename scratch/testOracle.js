const oracledb = require("oracledb");
const path = require("path");
require("dotenv").config();

async function run() {
  try {
    console.log("🚀 Debugging Node.js connection with Full Descriptor...");
    
    const user = process.env.ORACLE_USER || "ADMIN";
    const password = process.env.ORACLE_PASSWORD;
    const walletPath = path.join(process.cwd(), "wallet");

    // Full descriptor from tnsnames.ora
    const fullDescriptor = `(description= (retry_count=20)(retry_delay=3)(address=(protocol=tcps)(port=1522)(host=adb.ap-singapore-1.oraclecloud.com))(connect_data=(service_name=gba4ef248f7791d_codeatlasdatabase_low.adb.oraclecloud.com))(security=(ssl_server_dn_match=yes)))`;

    console.log("Using User:", user);

    const connection = await oracledb.getConnection({
      user: user,
      password: password,
      connectString: fullDescriptor,
      walletLocation: walletPath,
      walletPassword: password
    });

    console.log("✅ SUCCESS!");
    const result = await connection.execute("SELECT sysdate FROM dual");
    console.log("Result:", result.rows[0]);
    await connection.close();
  } catch (err) {
    console.error("❌ Failed!");
    console.error("Error:", err.message);
  }
}

run();
