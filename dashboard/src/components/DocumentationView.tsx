import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { 
  Settings, 
  Layers, 
  HelpCircle, 
  Copy, 
  Check, 
  BookOpen,
  ArrowRight,
  ExternalLink,
  Code,
  Sparkles
} from 'lucide-react';

export const DocumentationView: React.FC = () => {
  const [activeSubTab, setActiveSubTab] = useState<'mcp' | 'architecture' | 'graph'>('mcp');
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const backendUrl = window.location.origin.includes('localhost:5173')
    ? 'http://localhost:8080'
    : window.location.origin;

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(id);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const renderCopyButton = (text: string, id: string) => (
    <button
      onClick={() => handleCopy(text, id)}
      style={{
        position: 'absolute',
        top: '12px',
        right: '12px',
        background: 'rgba(255, 255, 255, 0.08)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: '8px',
        padding: '6px 12px',
        color: '#fff',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '0.75rem',
        fontWeight: 600,
        transition: 'all 0.2s ease',
      }}
      className="copy-btn-hover"
    >
      {copiedText === id ? (
        <>
          <Check size={14} color="#00F0FF" />
          <span style={{ color: '#00F0FF' }}>Copied</span>
        </>
      ) : (
        <>
          <Copy size={14} />
          <span>Copy</span>
        </>
      )}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
      
      {/* HEADER SECTION */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '1.5rem' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <span style={{ background: 'rgba(0, 240, 255, 0.12)', color: 'var(--primary-neon)', fontSize: '0.75rem', fontWeight: 800, padding: '0.25rem 0.75rem', borderRadius: '20px', border: '1px solid rgba(0, 240, 255, 0.2)' }}>
              v2.13.16 — Enterprise
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Sparkles size={14} color="#FFD700" /> Thick Mode Active
            </span>
          </div>
          <h1 className="tech-font" style={{ fontSize: '2.25rem', fontWeight: 900, background: 'linear-gradient(to right, #fff, #8892b0)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', margin: 0 }}>
            System Documentation
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '1rem', marginTop: '0.5rem', maxWidth: '600px', lineHeight: '1.5' }}>
            Configure client editors, manage deployment dependencies, and leverage advanced AI Graph metrics.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '1rem' }}>
          <a
            href={`${backendUrl}/api/docs/quick-setup`}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '12px',
              padding: '0.75rem 1.25rem',
              color: '#fff',
              fontSize: '0.9rem',
              fontWeight: 700,
              textDecoration: 'none',
              transition: 'all 0.2s ease',
            }}
            className="docs-btn-hover"
          >
            <BookOpen size={18} /> Quick Setup Guide <ExternalLink size={14} />
          </a>
          <a
            href={`${backendUrl}/api/docs/memory-setup`}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '12px',
              padding: '0.75rem 1.25rem',
              color: '#fff',
              fontSize: '0.9rem',
              fontWeight: 700,
              textDecoration: 'none',
              transition: 'all 0.2s ease',
            }}
            className="docs-btn-hover"
          >
            <BookOpen size={18} /> AI Memory Guide <ExternalLink size={14} />
          </a>
        </div>
      </div>

      {/* TABS SELECTOR */}
      <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '2px', gap: '2rem' }}>
        {[
          { id: 'mcp', label: 'MCP Editor Config', icon: Settings },
          { id: 'architecture', label: 'Architecture', icon: Layers },
          { id: 'graph', label: 'Interactive Guide', icon: HelpCircle },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id as any)}
              style={{
                background: 'transparent',
                border: 'none',
                borderBottom: isActive ? '3px solid var(--primary-neon)' : '3px solid transparent',
                padding: '0.75rem 0.5rem 1rem 0.5rem',
                color: isActive ? '#fff' : 'var(--text-muted)',
                fontWeight: 700,
                fontSize: '0.95rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                transition: 'all 0.25s ease',
                marginBottom: '-2px'
              }}
            >
              <Icon size={18} color={isActive ? 'var(--primary-neon)' : 'var(--text-muted)'} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB CONTENT PANEL */}
      <div style={{ background: 'rgba(13, 17, 23, 0.45)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '24px', padding: '2.5rem', minHeight: '400px' }}>
        
        {activeSubTab === 'architecture' && (
          <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#fff', marginBottom: '0.75rem' }}>CodeAtlas Tri-Layer Memory</h2>
              <p style={{ color: 'var(--text-muted)', lineHeight: '1.6', marginBottom: '2rem' }}>
                The engine utilizes a sophisticated multi-tier memory layout, isolating telemetry and codebase structures directly on Oracle 26ai Cloud Database:
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                {[
                  {
                    tier: 'Tier 1: Episodic Memory',
                    tech: 'Firebase / Oracle native JSON',
                    desc: 'Preserves chat transcripts, telemetry rules, user preferences, and manual business rules without database footprint overhead.'
                  },
                  {
                    tier: 'Tier 2: Semantic Memory',
                    tech: 'Oracle 26ai AI Vector Search',
                    desc: 'Converts codebase entities (functions, parameters, algorithms) into multidimensional Vector Embeddings to perform high-speed context matching.'
                  },
                  {
                    tier: 'Tier 3: Relational Memory',
                    tech: 'Oracle Property Graph (VPD)',
                    desc: 'Builds secure virtual private databases to track module dependencies, class containment, and execution flows in a native Graph structure.'
                  }
                ].map((t, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: '1.5rem', padding: '1.5rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '18px' }}>
                    <div style={{ width: '40px', height: '40px', background: 'rgba(0, 240, 255, 0.08)', border: '1px solid rgba(0, 240, 255, 0.15)', color: 'var(--primary-neon)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.1rem', fontWeight: 800 }}>
                      {idx + 1}
                    </div>
                    <div>
                      <h4 style={{ color: '#fff', fontSize: '1.05rem', fontWeight: 700, margin: '0 0 4px 0' }}>{t.tier}</h4>
                      <span style={{ fontSize: '0.75rem', color: 'var(--primary-neon)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 800 }}>{t.tech}</span>
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', margin: '8px 0 0 0', lineHeight: '1.5' }}>{t.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}

        {activeSubTab === 'mcp' && (
          <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#fff', marginBottom: '0.5rem' }}>MCP Server Configuration</h2>
              <p style={{ color: 'var(--text-muted)', lineHeight: '1.5', marginBottom: '1.5rem' }}>
                Enable your AI coding tools to read dependencies, trace feature flows, and run security scans directly on this server.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                <div>
                  <h3 style={{ color: 'var(--primary-neon)', fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ArrowRight size={16} /> 1. Cursor AI Editor
                  </h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1rem', lineHeight: '1.5' }}>
                    Go to <strong>Settings</strong> → <strong>Models</strong> → <strong>MCP</strong>. Click <strong>+ Add New MCP Tool</strong>:
                  </p>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <thead>
                      <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                        <th style={{ padding: '12px', textAlign: 'left', fontWeight: 700, color: '#fff' }}>Param</th>
                        <th style={{ padding: '12px', textAlign: 'left', fontWeight: 700, color: '#fff' }}>Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <td style={{ padding: '12px', fontWeight: 700, color: '#fff' }}>Name</td>
                        <td style={{ padding: '12px', color: 'var(--primary-neon)', fontFamily: 'monospace' }}>codeatlas</td>
                      </tr>
                      <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <td style={{ padding: '12px', fontWeight: 700, color: '#fff' }}>Type</td>
                        <td style={{ padding: '12px', color: 'var(--primary-neon)', fontFamily: 'monospace' }}>sse</td>
                      </tr>
                      <tr>
                        <td style={{ padding: '12px', fontWeight: 700, color: '#fff' }}>URL</td>
                        <td style={{ padding: '12px', color: 'var(--primary-neon)', fontFamily: 'monospace' }}>{backendUrl}/sse?apiKey=YOUR_API_KEY_HERE</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div>
                  <h3 style={{ color: 'var(--primary-neon)', fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ArrowRight size={16} /> 2. VS Code (Gemini / Antigravity)
                  </h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1rem', lineHeight: '1.5' }}>
                    Add this server configuration block inside your <code>.gemini/settings.json</code> using either the <strong>environment variable</strong> option (recommended) or the <strong>argument</strong> option:
                  </p>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div>
                      <div style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.5rem' }}>Option A: Environment Variable (Recommended)</div>
                      <div style={{ position: 'relative', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '1.5rem', fontFamily: 'monospace', fontSize: '0.85rem', color: '#ff79c6', overflowX: 'auto' }}>
                        <pre style={{ margin: 0 }}>{`{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "-p", "codeatlas-enterprise", "codeatlas-mcp"],
      "env": {
        "CODEATLAS_API_KEY": "YOUR_API_KEY_HERE"
      }
    }
  }
}`}</pre>
                        {renderCopyButton(`{\n  "mcpServers": {\n    "codeatlas": {\n      "command": "npx",\n      "args": ["-y", "-p", "codeatlas-enterprise", "codeatlas-mcp"],\n      "env": {\n        "CODEATLAS_API_KEY": "YOUR_API_KEY_HERE"\n      }\n    }\n  }\n}`, 'vscode_mcp_env')}
                      </div>
                    </div>

                    <div>
                      <div style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.5rem' }}>Option B: CLI Argument</div>
                      <div style={{ position: 'relative', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '1.5rem', fontFamily: 'monospace', fontSize: '0.85rem', color: '#ff79c6', overflowX: 'auto' }}>
                        <pre style={{ margin: 0 }}>{`{
  "mcpServers": {
    "codeatlas": {
      "command": "npx",
      "args": ["-y", "-p", "codeatlas-enterprise", "codeatlas-mcp", "--apiKey=YOUR_API_KEY_HERE"]
    }
  }
}`}</pre>
                        {renderCopyButton(`{\n  "mcpServers": {\n    "codeatlas": {\n      "command": "npx",\n      "args": ["-y", "-p", "codeatlas-enterprise", "codeatlas-mcp", "--apiKey=YOUR_API_KEY_HERE"]\n    }\n  }\n}`, 'vscode_mcp_arg')}
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <h3 style={{ color: 'var(--primary-neon)', fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <ArrowRight size={16} /> 3. AI Rules & Auto-Memory Templates (MDC / MD)
                  </h3>
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '1.25rem', lineHeight: '1.5' }}>
                    To ensure your AI assistant automatically leverages CodeAtlas MCP tools, understands context, and synchronizes codebase changes back to the knowledge graph, create the following rules files in your workspace root:
                  </p>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
                    <div>
                      <div style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.5rem' }}>1. Cursor AI Rules (<code>.cursor/rules/codeatlas.mdc</code>)</div>
                      <div style={{ position: 'relative', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '1.25rem', fontFamily: 'monospace', fontSize: '0.8rem', color: '#a6e22e', overflowX: 'auto', maxHeight: '250px', overflowY: 'auto' }}>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>{`---
description: CodeAtlas MCP Integration — Auto-read memory, use MCP tools before coding, sync after changes
globs: *
alwaysApply: true
---

# CodeAtlas MCP — Codebase Intelligence

An MCP server named \`codeatlas\` is available. It provides code analysis data including project structure, dependencies, and code insights.

**Always use CodeAtlas MCP tools BEFORE manual file searches — faster and gives relationship context.**

## Workflow
1. **Before making changes** → call \`trace_feature_flow\` with a keyword to find related files
2. **Looking for a function/class** → call \`search_entities\`. NEVER use grep or find commands.
3. **Understanding connections** → call \`get_dependencies\` for import/call relationships
4. **High-level overview** → call \`generate_system_flow\` for Mermaid architecture diagram
5. **Execution flow of a feature** → call \`generate_feature_flow_diagram\` for call-chain Mermaid diagram
6. **Exploring a file** → call \`get_file_entities\` to see all entities in that file
7. **After making changes** → call \`sync_system_memory\` to update AI memory`}</pre>
                        {renderCopyButton(`---\ndescription: CodeAtlas MCP Integration — Auto-read memory, use MCP tools before coding, sync after changes\nglobs: *\nalwaysApply: true\n---\n\n# CodeAtlas MCP — Codebase Intelligence\n\nAn MCP server named \`codeatlas\` is available. It provides code analysis data including project structure, dependencies, and code insights.\n\n**Always use CodeAtlas MCP tools BEFORE manual file searches — faster and gives relationship context.**\n\n## Workflow\n1. **Before making changes** → call \`trace_feature_flow\` with a keyword to find related files\n2. **Looking for a function/class** → call \`search_entities\`. NEVER use grep or find commands.\n3. **Understanding connections** → call \`get_dependencies\` for import/call relationships\n4. **High-level overview** → call \`generate_system_flow\` for Mermaid architecture diagram\n5. **Execution flow of a feature** → call \`generate_feature_flow_diagram\` for call-chain Mermaid diagram\n6. **Exploring a file** → call \`get_file_entities\` to see all entities in that file\n7. **After making changes** → call \`sync_system_memory\` to update AI memory`, 'cursor_rules_mdc')}
                      </div>
                    </div>

                    <div>
                      <div style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.5rem' }}>2. CodeAtlas MCP Workflow (<code>.agents/rules/codeatlas-mcp.md</code>)</div>
                      <div style={{ position: 'relative', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '1.25rem', fontFamily: 'monospace', fontSize: '0.8rem', color: '#a6e22e', overflowX: 'auto', maxHeight: '250px', overflowY: 'auto' }}>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>{`---
description: CodeAtlas MCP Integration — Auto-read memory, use MCP tools before coding, sync after changes
globs: *
alwaysApply: true
trigger: always_on
---

## CodeAtlas MCP — Codebase Intelligence

An MCP server named \`codeatlas\` is available. It provides code analysis data including project structure, dependencies, and code insights.

**Always use CodeAtlas MCP tools BEFORE manual file searches — faster and gives relationship context.**

### Workflow

1. **Before making changes** → call \`trace_feature_flow\` with a keyword to find related files
2. **Looking for a function/class** → call \`search_entities\`. NEVER use grep or find commands.
3. **Understanding connections** → call \`get_dependencies\` for import/call relationships
4. **High-level overview** → call \`generate_system_flow\` for Mermaid architecture diagram
5. **Execution flow of a feature** → call \`generate_feature_flow_diagram\` for call-chain Mermaid diagram
6. **Exploring a file** → call \`get_file_entities\` to see all entities in that file
7. **After making changes** → call \`sync_system_memory\` to update AI memory

### Important
- Data is automatically indexed by the client on startup or modification and synced to the server database via the API (\`/api/projects/sync\`).
- If no analysis is loaded, verify that the client has completed indexing and synchronized with the remote server.

### Example Workflow

\`\`\`
User: "fix login timeout"

1. trace_feature_flow(keyword: "login")              → find related files
2. generate_feature_flow_diagram(keyword: "login")   → see execution flow
3. Read files in readingOrder                        → understand logic
4. Fix the code                                      → implement fix
5. sync_system_memory(changeDescription: "Fixed login timeout") → save context
\`\`\``}</pre>
                        {renderCopyButton(`---\ndescription: CodeAtlas MCP Integration — Auto-read memory, use MCP tools before coding, sync after changes\nglobs: *\nalwaysApply: true\ntrigger: always_on\n---\n\n## CodeAtlas MCP — Codebase Intelligence\n\nAn MCP server named \`codeatlas\` is available. It provides code analysis data including project structure, dependencies, and code insights.\n\n**Always use CodeAtlas MCP tools BEFORE manual file searches — faster and gives relationship context.**\n\n### Workflow\n\n1. **Before making changes** → call \`trace_feature_flow\` with a keyword to find related files\n2. **Looking for a function/class** → call \`search_entities\`. NEVER use grep or find commands.\n3. **Understanding connections** → call \`get_dependencies\` for import/call relationships\n4. **High-level overview** → call \`generate_system_flow\` for Mermaid architecture diagram\n5. **Execution flow of a feature** → call \`generate_feature_flow_diagram\` for call-chain Mermaid diagram\n6. **Exploring a file** → call \`get_file_entities\` to see all entities in that file\n7. **After making changes** → call \`sync_system_memory\` to update AI memory\n\n### Important\n- Data is automatically indexed by the client on startup or modification and synced to the server database via the API (\`/api/projects/sync\`).\n- If no analysis is loaded, verify that the client has completed indexing and synchronized with the remote server.\n\n### Example Workflow\n\n\`\`\`\nUser: \"fix login timeout\"\n\n1. trace_feature_flow(keyword: \"login\")              → find related files\n2. generate_feature_flow_diagram(keyword: \"login\")   → see execution flow\n3. Read files in readingOrder                        → understand logic\n4. Fix the code                                      → implement fix\n5. sync_system_memory(changeDescription: \"Fixed login timeout\") → save context\n\`\`\``, 'generic_rules_md')}
                      </div>
                    </div>

                    <div>
                      <div style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.5rem' }}>3. AI Memory & Auto-Sync (<code>.agents/rules/auto-memory.md</code>)</div>
                      <div style={{ position: 'relative', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '1.25rem', fontFamily: 'monospace', fontSize: '0.8rem', color: '#a6e22e', overflowX: 'auto', maxHeight: '250px', overflowY: 'auto' }}>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>{`---
trigger: always_on
---

## AI System Memory — Auto-Read & Auto-Sync

### 🧠 MANDATORY: Remote Memory & Telemetry System
All system mapping, business rules, coding conventions, and change logs are automatically synchronized to the central CodeAtlas telemetry server and Oracle 26ai Knowledge Graph database. The local \`.agents/memory\` directory is no longer stored on disk to avoid redundant files and simplify codebase maintenance. 
Use the CodeAtlas MCP tools to query or search relationships, dependencies, and insights directly from the indexed system knowledge.

### 🔎 MANDATORY: Use CodeAtlas MCP to Understand Code BEFORE Making Changes
**NEVER start coding without understanding the codebase first.** Follow this flow:
1. **User describes a problem/feature** → FIRST call \`trace_feature_flow\` with a keyword
2. **Need to find a specific function/class** → call \`search_entities\`. NEVER use grep or find commands.
3. **Need to understand how things connect** → call \`get_dependencies\`
4. **Need a high-level overview** → call \`generate_system_flow\`
5. **Need to see execution flow of a feature** → call \`generate_feature_flow_diagram\`
6. **Need to know what's in a specific file** → call \`get_file_entities\`

### 🔄 MANDATORY: Sync Memory After Changes
**After completing ANY code changes, you MUST call \`sync_system_memory\`:**
1. **\`changeDescription\`** (ALWAYS required): What you just changed
2. **\`businessRule\`** (ALWAYS extract if user mentions ANY domain logic):
   - ALWAYS save when user mentions Conditions, Permissions, Limits, or Filters.
   - If you are unsure whether something is a business rule, SAVE IT ANYWAY.`}</pre>
                        {renderCopyButton(`---\ntrigger: always_on\n---\n\n## AI System Memory — Auto-Read & Auto-Sync\n\n### 🧠 MANDATORY: Remote Memory & Telemetry System\nAll system mapping, business rules, coding conventions, and change logs are automatically synchronized to the central CodeAtlas telemetry server and Oracle 26ai Knowledge Graph database. The local \`.agents/memory\` directory is no longer stored on disk to avoid redundant files and simplify codebase maintenance. \nUse the CodeAtlas MCP tools to query or search relationships, dependencies, and insights directly from the indexed system knowledge.\n\n### 🔎 MANDATORY: Use CodeAtlas MCP to Understand Code BEFORE Making Changes\n**NEVER start coding without understanding the codebase first.** Follow this flow:\n1. **User describes a problem/feature** → FIRST call \`trace_feature_flow\` with a keyword\n2. **Need to find a specific function/class** → call \`search_entities\`. NEVER use grep or find commands.\n3. **Need to understand how things connect** → call \`get_dependencies\`\n4. **Need a high-level overview** → call \`generate_system_flow\`\n5. **Need to see execution flow of a feature** → call \`generate_feature_flow_diagram\`\n6. **Need to know what's in a specific file** → call \`get_file_entities\`\n\n### 🔄 MANDATORY: Sync Memory After Changes\n**After completing ANY code changes, you MUST call \`sync_system_memory\`:**\n1. **\`changeDescription\`** (ALWAYS required): What you just changed\n2. **\`businessRule\`** (ALWAYS extract if user mentions ANY domain logic):\n   - ALWAYS save when user mentions Conditions, Permissions, Limits, or Filters.\n   - If you are unsure whether something is a business rule, SAVE IT ANYWAY.`, 'auto_memory_rules_md')}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {activeSubTab === 'graph' && (
          <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#fff', marginBottom: '0.75rem' }}>Interactive Canvas Manual</h2>
              <p style={{ color: 'var(--text-muted)', lineHeight: '1.6', marginBottom: '1.5rem' }}>
                Interact with the dynamic force-directed Knowledge Graph panel using physical mouse mechanics:
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
                {[
                  {
                    action: 'Pan Canvas',
                    desc: 'Left-click and hold anywhere on the empty dark backing, then slide your mouse to move around the universe.',
                    shortcut: 'Hold Left-Click + Move'
                  },
                  {
                    action: 'Zoom Control',
                    desc: 'Use your mouse scroll wheel or notebook touchpad gestures to scale the network fluidly from 0.2x to 6.0x.',
                    shortcut: 'Scroll Wheel / Pinch'
                  },
                  {
                    action: 'Drag Entities',
                    desc: 'Hover over a file or function node, left-click and pull to isolate the node and highlight its connected relationships.',
                    shortcut: 'Left-click & Drag Node'
                  },
                  {
                    action: 'Fullscreen Mode 📺',
                    desc: 'Click the glasmorphic Maximize toggle HUD button in the bottom right corner to enter layout-borderless mode.',
                    shortcut: 'Click HUD Maximize / ESC to Exit'
                  }
                ].map((g, idx) => (
                  <div key={idx} style={{ padding: '1.5rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '18px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div>
                      <h4 style={{ color: '#fff', fontSize: '1.05rem', fontWeight: 700, margin: '0 0 8px 0' }}>{g.action}</h4>
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.88rem', lineHeight: '1.5', margin: 0 }}>{g.desc}</p>
                    </div>
                    <div style={{ marginTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 800 }}>Shortcut</span>
                      <span style={{ fontSize: '0.75rem', background: 'rgba(0, 240, 255, 0.1)', color: 'var(--primary-neon)', border: '1px solid rgba(0, 240, 255, 0.2)', padding: '3px 8px', borderRadius: '6px', fontFamily: 'monospace' }}>
                        {g.shortcut}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </motion.div>
        )}

      </div>

      <style>{`
        .copy-btn-hover:hover {
          background: rgba(255, 255, 255, 0.15) !important;
          border-color: rgba(255, 255, 255, 0.25) !important;
        }
        .docs-btn-hover:hover {
          background: rgba(255,255,255,0.08) !important;
          border-color: rgba(0, 240, 255, 0.3) !important;
          box-shadow: 0 0 15px rgba(0, 240, 255, 0.1);
        }
      `}</style>

    </div>
  );
};
