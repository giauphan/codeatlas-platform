const oracledb = require("oracledb");
const path = require("path");

async function run() {
  try {
    console.log("🚀 Testing Oracle connection using Wallet from ai-video-distributor...");
    
    // Using credentials discovered from the other repo
    const user = "ADMIN";
    const password = "King0945451081#*";
    const walletPath = "/home/biibon/ai-video-distributor/oracle_wallet";
    const connectString = "v76djvdju5sgmwaz_low";

    console.log("Using User:", user);
    console.log("Wallet Path:", walletPath);

    const connection = await oracledb.getConnection({
      user: user,
      password: password,
      connectString: connectString,
      walletLocation: walletPath,
      walletPassword: password, // As seen in the other repo's .env
      configDir: walletPath     // Equivalent to config_dir in Python
    });

    console.log("✅ BOOM! Connected successfully using the other repo's wallet!");
    const result = await connection.execute("SELECT sysdate FROM dual");
    console.log("Result:", result.rows[0]);
    await connection.close();
  } catch (err) {
    console.error("❌ Still failed, even with the working wallet!");
    console.error("Error:", err.message);
  }
}

run();
