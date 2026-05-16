# 🗺️ CodeAtlas Enterprise (Oracle 26ai Edition)

**Standalone MCP Server & Remote API for AI-powered codebase intelligence**

[![Version](https://img.shields.io/badge/version-2.0.0-gold)](https://github.com/giauphan/CodeAtlas/releases)
[![Oracle](https://img.shields.io/badge/Oracle-26ai%20Native-red?logo=oracle)](https://www.oracle.com/database/)
[![MCP](https://img.shields.io/npm/v/@giauphan/codeatlas-mcp?label=MCP%20Server&logo=npm)](https://www.npmjs.com/package/@giauphan/codeatlas-mcp)

CodeAtlas Enterprise is a production-grade, standalone server that transforms your codebase into a **Knowledge Graph**. Built on **Oracle 26ai**, it provides deep architectural reasoning, security scanning, and persistent AI memory for enterprise-scale teams.

---

## 🚀 Linux Server Setup

### 1. Prerequisites
- **Node.js**: v20.0.0 or higher.
  - Install via NodeSource (Recommended for Linux):
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```
- **Oracle Instant Client**: Required for **Thick Mode** connectivity.
  - Download and extract to `/opt/oracle/instantclient`
  - Set `LD_LIBRARY_PATH` and `ORACLE_HOME`
- **Firebase Project**: For API Key authentication.

### 2. Installation
```bash
git clone https://github.com/giauphan/CodeAtlas.git
cd CodeAtlas
npm install
npm run build
```

### 3. Environment Configuration
Create a `.env` file or export variables:
```bash
PORT=8080
CODEATLAS_API_KEY=your_admin_secret_key  # Optional: For server-wide security
GOOGLE_APPLICATION_CREDENTIALS=/path/to/firebase-service-account.json

# Oracle 26ai Configuration (Thick Mode)
ORACLE_USER=admin
ORACLE_PASS=your_password
ORACLE_CONN_STR=your_db_connection_string
ORACLE_LIB_DIR=/opt/oracle/instantclient
ORACLE_WALLET_DIR=/opt/oracle/wallet  # If using mTLS
```

### 4. Running with PM2 (Recommended)
```bash
npm install -g pm2
pm2 start dist/index.js --name codeatlas-enterprise
pm2 save
```

---

## 🛠️ Enterprise MCP Tools

### 🏗️ Knowledge Graph Reasoning (Pro/Plus Only)
| Tool | What it does |
|------|-------------|
| `detect_architectural_smells` | Uses Oracle Graph to find **Circular Dependencies**, **God Objects**, and **Dead Code**. |
| `sync_system_memory` | Syncs code relationships and business rules directly to **Oracle Knowledge Graph**. |

### 🛡️ Enterprise Scanner (Pro/Plus Only)
| Tool | What it does |
|------|-------------|
| `scan_enterprise_vulnerabilities` | Auto-scans all projects for **Hardcoded Secrets**, **Unsafe Functions** (eval/exec), and **SQL Injection**. |

### 📊 Standard Tools
| Tool | What it does |
|------|-------------|
| `list_projects` | List all projects currently managed by the server. |
| `get_project_structure` | Detailed entity listing (Modules, Classes, Functions). |
| `generate_system_flow` | Mermaid architecture diagrams. |
| `generate_feature_flow_diagram` | Mermaid execution flow diagrams. |

---

## 🧠 Memory Architecture
CodeAtlas Enterprise uses a **Tri-Layer Memory** system:
1. **Episodic (Firebase)**: Chat history and specific task context.
2. **Semantic (Oracle Vector Search)**: Deep code understanding and vector-based retrieval.
3. **Relational (Oracle Property Graph)**: Knowledge Graph reasoning for complex dependencies.

---

## 💳 Subscription Plans
| Feature | Free | Plus | Pro |
|---|---|---|---|
| Project Limit | 3 | 20 | Unlimited |
| Basic Analysis | ✅ | ✅ | ✅ |
| AI Memory (Files) | ✅ | ✅ | ✅ |
| **Security Scan** | ❌ | ✅ | ✅ |
| **Graph Reasoning** | ❌ | ✅ | ✅ |
| **Private Hosting** | ❌ | ❌ | ✅ |

---

## 🧪 Testing
Run the comprehensive test suite (including security and graph mocks):
```bash
npm test
```

## License
Proprietary — Contact `giauphan` for enterprise licensing.
