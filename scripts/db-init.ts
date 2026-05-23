import oracledb from "oracledb";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

// Load environment variables
dotenv.config();

const dbConfig = {
  user: process.env.ORACLE_USER || "ADMIN",
  password: process.env.ORACLE_PASSWORD || "",
  connectString: process.env.ORACLE_CONN_STRING || ""
};

async function run() {
  console.log("⚙️ Starting automatic Oracle Database initialization...");

  // Initialize Thick Mode if libDir is specified
  const libDir = process.env.ORACLE_LIB_DIR || "./instantclient";
  const configDir = process.env.ORACLE_WALLET_DIR || "./wallet";
  
  const absoluteLibDir = path.isAbsolute(libDir) ? libDir : path.join(process.cwd(), libDir);
  const absoluteConfigDir = path.isAbsolute(configDir) ? configDir : path.join(process.cwd(), configDir);

  if (fs.existsSync(absoluteLibDir)) {
    try {
      console.log(`🚀 Initializing Oracle Client in Thick Mode from: ${absoluteLibDir}`);
      const initOptions: any = {
        configDir: absoluteConfigDir
      };
      if (process.platform !== "linux") {
        initOptions.libDir = absoluteLibDir;
      }
      oracledb.initOracleClient(initOptions);
    } catch (err: any) {
      if (err.message.includes("already initialized")) {
        console.log("ℹ️ Oracle Client is already initialized.");
      } else {
        console.warn("⚠️ Warning initializing Oracle Client:", err.message);
      }
    }
  } else {
    console.warn(`⚠️ Oracle Instant Client directory not found at: ${absoluteLibDir}. Trying Thin Mode...`);
  }

  console.log(`🔌 Connecting to Oracle database as ${dbConfig.user}...`);
  let connection: oracledb.Connection | null = null;
  try {
    connection = await oracledb.getConnection(dbConfig);
    console.log("✅ Successfully connected to database.");
  } catch (err: any) {
    console.error("❌ Failed to connect to database:", err.message);
    process.exit(1);
  }

  // Helper function to execute SQL safely (log and ignore exists error)
  const execSql = async (sql: string, description: string) => {
    try {
      console.log(`   Executing: ${description}...`);
      await connection!.execute(sql);
      console.log(`   └─ Success.`);
    } catch (err: any) {
      // Common Oracle error codes to skip if object already exists:
      // ORA-00955: name is already used by an existing object
      // ORA-02261: unique or primary key already exists in table
      // ORA-01430: column being added already exists in table
      // ORA-02264: name already used by an existing constraint
      // ORA-04004: property graph already exists
      // ORA-28101: policy already exists
      if (
        err.errorNum === 955 ||
        err.errorNum === 2261 ||
        err.errorNum === 1430 ||
        err.errorNum === 4004 ||
        err.errorNum === 28101
      ) {
        console.log(`   └─ Already exists (Skipped).`);
      } else {
        console.error(`   └─ ❌ Error:`, err.message);
      }
    }
  };

  try {
    console.log("\n📦 1. Initializing Tables & Indexes...");

    await execSql(`
      CREATE TABLE ai_episodic_memory (
          id VARCHAR2(255) PRIMARY KEY,
          project_name VARCHAR2(255) NOT NULL,
          event_type VARCHAR2(50) NOT NULL,
          event_data JSON,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          tenant_id VARCHAR2(255) DEFAULT 'admin' NOT NULL
      )
    `, "CREATE TABLE ai_episodic_memory");

    await execSql(`
      CREATE INDEX idx_episodic_tenant_proj ON ai_episodic_memory(tenant_id, project_name)
    `, "CREATE INDEX idx_episodic_tenant_proj");

    await execSql(`
      CREATE TABLE ai_semantic_memory (
          id VARCHAR2(255) PRIMARY KEY,
          project_name VARCHAR2(255) NOT NULL,
          entity_type VARCHAR2(50),
          entity_name VARCHAR2(255),
          file_path VARCHAR2(1000),
          content CLOB,
          embedding VECTOR(1536, FLOAT32),
          tenant_id VARCHAR2(255) DEFAULT 'admin' NOT NULL
      )
    `, "CREATE TABLE ai_semantic_memory");

    await execSql(`
      CREATE INDEX idx_semantic_tenant_proj ON ai_semantic_memory(tenant_id, project_name)
    `, "CREATE INDEX idx_semantic_tenant_proj");

    await execSql(`
      CREATE TABLE ai_relational_memory (
          source_id VARCHAR2(255),
          target_id VARCHAR2(255),
          project_name VARCHAR2(255),
          relationship_type VARCHAR2(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP,
          tenant_id VARCHAR2(255) DEFAULT 'admin' NOT NULL,
          PRIMARY KEY(source_id, target_id, relationship_type, tenant_id)
      )
    `, "CREATE TABLE ai_relational_memory");

    // Optional property graph
    await execSql(`
      CREATE PROPERTY GRAPH ai_knowledge_graph
          VERTEX TABLES (
              ai_semantic_memory KEY(id)
              PROPERTIES (project_name, entity_type, entity_name, file_path, tenant_id)
          )
          EDGE TABLES (
              ai_relational_memory KEY(source_id, target_id, relationship_type, tenant_id)
              SOURCE KEY(source_id) REFERENCES ai_semantic_memory(id)
              DESTINATION KEY(target_id) REFERENCES ai_semantic_memory(id)
              PROPERTIES (relationship_type, created_at, expires_at, tenant_id)
          )
    `, "CREATE PROPERTY GRAPH ai_knowledge_graph");

    console.log("\n🔒 2. Setting up Virtual Private Database (VPD) RLS Context...");

    await execSql(`
      CREATE OR REPLACE CONTEXT codeatlas_ctx USING ADMIN.codeatlas_ctx_pkg
    `, "CREATE CONTEXT codeatlas_ctx");

    await execSql(`
      CREATE OR REPLACE PACKAGE codeatlas_ctx_pkg IS
          PROCEDURE set_tenant(p_tenant_id IN VARCHAR2);
      END;
    `, "CREATE OR REPLACE PACKAGE codeatlas_ctx_pkg spec");

    await execSql(`
      CREATE OR REPLACE PACKAGE BODY codeatlas_ctx_pkg IS
          PROCEDURE set_tenant(p_tenant_id IN VARCHAR2) IS
          BEGIN
              DBMS_SESSION.SET_CONTEXT('codeatlas_ctx', 'tenant_id', p_tenant_id);
          END;
      END;
    `, "CREATE OR REPLACE PACKAGE BODY codeatlas_ctx_pkg body");

    console.log("\n🧪 3. Creating Predicate Filter Function...");

    await execSql(`
      CREATE OR REPLACE FUNCTION get_tenant_predicate(
          p_schema IN VARCHAR2,
          p_table  IN VARCHAR2
      ) RETURN VARCHAR2 IS
          v_tenant_id VARCHAR2(255);
      BEGIN
          v_tenant_id := SYS_CONTEXT('codeatlas_ctx', 'tenant_id');
          IF v_tenant_id IS NULL THEN
              RETURN '1=0';
          ELSE
              RETURN 'tenant_id = ''' || v_tenant_id || '''';
          END IF;
      END;
    `, "CREATE OR REPLACE FUNCTION get_tenant_predicate");

    console.log("\n🚦 4. Registering Security Policies (DBMS_RLS)...");

    await execSql(`
      BEGIN
          -- 1. Bảng Episodic Memory
          BEGIN
            DBMS_RLS.ADD_POLICY(
                object_schema   => 'ADMIN',
                object_name     => 'ai_episodic_memory',
                policy_name     => 'episodic_tenant_policy',
                function_schema => 'ADMIN',
                policy_function => 'get_tenant_predicate',
                statement_types => 'SELECT,INSERT,UPDATE,DELETE',
                update_check    => TRUE
            );
          EXCEPTION
            WHEN OTHERS THEN
              IF SQLCODE = -28101 THEN
                NULL; -- Policy already exists
              ELSE
                RAISE;
              END IF;
          END;
          
          -- 2. Bảng Semantic Memory
          BEGIN
            DBMS_RLS.ADD_POLICY(
                object_schema   => 'ADMIN',
                object_name     => 'ai_semantic_memory',
                policy_name     => 'semantic_tenant_policy',
                function_schema => 'ADMIN',
                policy_function => 'get_tenant_predicate',
                statement_types => 'SELECT,INSERT,UPDATE,DELETE',
                update_check    => TRUE
            );
          EXCEPTION
            WHEN OTHERS THEN
              IF SQLCODE = -28101 THEN
                NULL; -- Policy already exists
              ELSE
                RAISE;
              END IF;
          END;
          
          -- 3. Bảng Relational Memory
          BEGIN
            DBMS_RLS.ADD_POLICY(
                object_schema   => 'ADMIN',
                object_name     => 'ai_relational_memory',
                policy_name     => 'relational_tenant_policy',
                function_schema => 'ADMIN',
                policy_function => 'get_tenant_predicate',
                statement_types => 'SELECT,INSERT,UPDATE,DELETE',
                update_check    => TRUE
            );
          EXCEPTION
            WHEN OTHERS THEN
              IF SQLCODE = -28101 THEN
                NULL; -- Policy already exists
              ELSE
                RAISE;
              END IF;
          END;
      END;
    `, "REGISTER RLS POLICIES");

    console.log("\n🎉 Database migration & auto-initialization successfully complete!");
  } catch (err: any) {
    console.error("❌ Auto-init failed with fatal error:", err.message);
  } finally {
    if (connection) {
      try {
        await connection.close();
        console.log("🔌 Connection closed.");
      } catch {}
    }
  }
}

run();
