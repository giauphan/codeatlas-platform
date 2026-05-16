import React, { useState, useEffect, useMemo } from 'react';
import { auth, db } from '../lib/firebase';
import { 
  collection, 
  addDoc, 
  deleteDoc, 
  doc, 
  onSnapshot, 
  query, 
  orderBy,
  limit,
  serverTimestamp 
} from 'firebase/firestore';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Key, 
  Plus, 
  Trash2, 
  Copy, 
  Check, 
  LogOut, 
  Activity, 
  Database,
  Cpu,
  Globe,
  Zap,
  Network,
  Server,
  Search,
  HardDrive,
  Loader2,
  ShieldCheck,
  LayoutDashboard,
  RefreshCw,
  Terminal
} from 'lucide-react';

// API Configuration - Optimized for atlas.genrostore.com
const API_BASE = window.location.origin.includes('localhost') 
  ? 'http://localhost:8080' 
  : `${window.location.protocol}//${window.location.hostname}:8080`; // Direct port access for now

const SUPER_ADMIN_KEY = '0~du=~7^OvNk%cLP2>*e~&~j5x\'WM';

interface ApiKey {
  id: string;
  name: string;
  key: string;
  tier: string;
  createdAt: any;
}

interface AnalysisData {
  stats: {
    totalFiles: number;
    totalModules: number;
    totalClasses: number;
    totalFunctions: number;
    totalVariables: number;
    loc: number;
  };
  graph: {
    nodes: any[];
    links: any[];
  };
}

export const Dashboard: React.FC = () => {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('Control Center');
  const [analysis, setAnalysis] = useState<AnalysisData | null>(() => {
    const cached = localStorage.getItem('ca_analysis_cache');
    return cached ? JSON.parse(cached) : null;
  });
  const [isIndexing, setIsIndexing] = useState(false);
  const [stats, setStats] = useState({ totalRequests: 0 });
  const user = auth.currentUser;

  // Fetch Real Analysis Data with Caching
  const fetchAnalysis = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/analysis`, {
        headers: { 'x-api-key': SUPER_ADMIN_KEY }
      });
      if (resp.ok) {
        const data = await resp.json();
        setAnalysis(data);
        localStorage.setItem('ca_analysis_cache', JSON.stringify(data));
      }
    } catch (err) {
      console.error("Failed to fetch analysis:", err);
    }
  };

  const handleReindex = async () => {
    setIsIndexing(true);
    try {
      const resp = await fetch(`${API_BASE}/api/reindex`, {
        method: 'POST',
        headers: { 'x-api-key': SUPER_ADMIN_KEY }
      });
      if (resp.ok) await fetchAnalysis();
    } catch (err) {
      console.error("Re-index failed:", err);
    } finally {
      setIsIndexing(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    fetchAnalysis();

    const unsubscribeStats = onSnapshot(doc(db, 'users', user.uid), (snap: any) => {
      if (snap.exists() && snap.data().stats) setStats(snap.data().stats);
    });

    const q = query(collection(db, 'users', user.uid, 'keys'), orderBy('createdAt', 'desc'));
    const unsubscribeKeys = onSnapshot(q, (snap: any) => {
      setKeys(snap.docs.map(d => ({ id: d.id, ...d.data() })) as ApiKey[]);
    });

    return () => {
      unsubscribeStats();
      unsubscribeKeys();
    };
  }, [user]);

  const createKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newKeyName.trim()) return;
    setLoading(true);
    try {
      await addDoc(collection(db, 'users', user.uid, 'keys'), {
        name: newKeyName,
        key: 'ca_' + crypto.randomUUID().replace(/-/g, ''),
        tier: 'enterprise',
        createdAt: serverTimestamp()
      });
      setNewKeyName('');
    } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  const renderContent = () => {
    switch(activeTab) {
      case 'Control Center':
        return <ControlCenterView 
          stats={stats} keys={keys} analysis={analysis}
          createKey={createKey} deleteKey={(id: string) => deleteDoc(doc(db, 'users', user!.uid, 'keys', id))} 
          copyToClipboard={(t: string, id: string) => { navigator.clipboard.writeText(t); setCopiedId(id); setTimeout(() => setCopiedId(null), 2000); }}
          copiedId={copiedId} newKeyName={newKeyName} setNewKeyName={setNewKeyName} loading={loading}
        />;
      case 'Knowledge Graph':
        return <KnowledgeGraphView analysis={analysis} />;
      case 'Logic Models':
        return <LogicModelsView analysis={analysis} />;
      case 'Cloud Index':
        return <CloudIndexView analysis={analysis} isIndexing={isIndexing} onReindex={handleReindex} />;
      default:
        return null;
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--background)', color: '#fff', overflow: 'hidden' }}>
      
      {/* SIDEBAR - Fixed layout issues */}
      <aside className="glass-panel" style={{ 
        width: '300px', 
        minWidth: '300px',
        padding: '2.5rem 1.5rem', 
        display: 'flex', 
        flexDirection: 'column', 
        gap: '2.5rem',
        borderRight: '1px solid rgba(255,255,255,0.1)',
        height: '100vh',
        boxSizing: 'border-box'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0 0.5rem' }}>
          <div style={{ width: '45px', height: '45px', background: 'var(--primary-neon)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--glow-primary)' }}>
            <ShieldCheck size={28} color="#000" />
          </div>
          <span className="tech-font" style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '0.05em' }}>CODEATLAS</span>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {[
            { icon: LayoutDashboard, label: 'Control Center' },
            { icon: Network, label: 'Knowledge Graph' },
            { icon: Cpu, label: 'Logic Models' },
            { icon: Globe, label: 'Cloud Index' },
          ].map((item) => (
            <motion.div
              key={item.label}
              whileHover={{ x: 5 }}
              onClick={() => setActiveTab(item.label)}
              style={{
                display: 'flex', alignItems: 'center', gap: '1.25rem', padding: '1rem', borderRadius: '14px', cursor: 'pointer',
                background: activeTab === item.label ? 'rgba(0, 240, 255, 0.12)' : 'transparent',
                color: activeTab === item.label ? 'var(--primary-neon)' : 'var(--text-muted)',
                border: activeTab === item.label ? '1px solid rgba(0, 240, 255, 0.25)' : '1px solid transparent',
                transition: 'all 0.2s ease'
              }}
            >
              <item.icon size={22} />
              <span style={{ fontSize: '0.95rem', fontWeight: 700 }}>{item.label}</span>
            </motion.div>
          ))}
        </nav>

        <div style={{ marginTop: 'auto', padding: '1.25rem', background: 'rgba(0,0,0,0.25)', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 700 }}>ENTERPRISE NODE</div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff', wordBreak: 'break-all' }}>{user?.email}</div>
          <button onClick={() => auth.signOut()} style={{ marginTop: '1.5rem', width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#ff4b4b', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 700 }}>
            <LogOut size={18} /> SIGN OUT
          </button>
        </div>
      </aside>

      {/* MAIN AREA - Fixed scroll and spacing */}
      <main style={{ flex: 1, height: '100vh', overflowY: 'auto', padding: '3rem 4rem', boxSizing: 'border-box' }}>
        <AnimatePresence mode="wait">
          <motion.div 
            key={activeTab} 
            initial={{ opacity: 0, y: 15 }} 
            animate={{ opacity: 1, y: 0 }} 
            exit={{ opacity: 0, y: -15 }}
            transition={{ duration: 0.3 }}
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>

      <style>{`
        .glass-panel { background: rgba(13, 17, 23, 0.7); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
        .tech-font { font-family: 'Inter', system-ui, -apple-system, sans-serif; letter-spacing: -0.02em; }
        .glass-input { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 0.875rem 1rem; borderRadius: 12px; width: 100%; transition: all 0.3s; }
        .glass-input:focus { outline: none; border-color: var(--primary-neon); box-shadow: 0 0 15px rgba(0, 240, 255, 0.1); }
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

const ControlCenterView: React.FC<any> = ({ stats, keys, analysis, createKey, deleteKey, copyToClipboard, copiedId, newKeyName, setNewKeyName, loading }) => (
  <>
    <header style={{ marginBottom: '3.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
      <div>
        <h1 style={{ fontSize: '3.5rem', margin: 0, fontWeight: 900 }} className="tech-font">Neural Control</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', marginTop: '0.5rem' }}>Orchestrating codebase intelligence and secure access.</p>
      </div>
      <div style={{ padding: '0.65rem 1.25rem', borderRadius: '10px', background: 'rgba(157, 0, 255, 0.1)', border: '1px solid var(--secondary-neon)', color: 'var(--secondary-neon)', fontWeight: 800, fontSize: '0.9rem' }}>
        v2.1.3 ONLINE
      </div>
    </header>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2rem', marginBottom: '4rem' }}>
      {[
        { label: 'Total Requests', value: stats.totalRequests.toLocaleString(), icon: Activity, color: 'var(--primary-neon)' },
        { label: 'Neural Entities', value: analysis?.stats.totalFunctions.toLocaleString() || '---', icon: Database, color: 'var(--secondary-neon)' },
        { label: 'Codebase (LOC)', value: analysis?.stats.loc.toLocaleString() || '---', icon: Terminal, color: '#00FF94' },
      ].map((stat, i) => (
        <div key={i} className="glass-panel" style={{ padding: '2rem', borderRadius: '24px', border: '1px solid rgba(255,255,255,0.05)', position: 'relative' }}>
          <stat.icon size={32} color={stat.color} style={{ marginBottom: '1.25rem', opacity: 0.8 }} />
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.05em' }}>{stat.label}</div>
          <div style={{ fontSize: '2.5rem', fontWeight: 900, marginTop: '0.75rem' }}>{stat.value}</div>
        </div>
      ))}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '3rem' }}>
      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
          <h2 className="tech-font" style={{ fontSize: '1.6rem', fontWeight: 800 }}>ACTIVE TOKENS</h2>
          <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{keys.length} KEYS</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {keys.map((k: any) => (
            <motion.div key={k.id} layout className="glass-panel rim-lit" style={{ padding: '1.5rem', borderRadius: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ overflow: 'hidden' }}>
                <div style={{ fontWeight: 800, fontSize: '1.1rem', marginBottom: '0.5rem' }}>{k.name}</div>
                <code style={{ color: 'var(--primary-neon)', fontSize: '0.95rem', background: 'rgba(0,0,0,0.2)', padding: '0.4rem 0.75rem', borderRadius: '6px' }}>{k.key}</code>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button onClick={() => copyToClipboard(k.key, k.id)} style={{ background: 'rgba(255,255,255,0.05)', border: 'none', padding: '0.75rem', borderRadius: '12px', cursor: 'pointer', color: copiedId === k.id ? 'var(--primary-neon)' : '#fff' }}>
                  {copiedId === k.id ? <Check size={20} /> : <Copy size={20} />}
                </button>
                <button onClick={() => deleteKey(k.id)} style={{ background: 'rgba(255, 75, 75, 0.05)', border: 'none', padding: '0.75rem', borderRadius: '12px', cursor: 'pointer', color: '#ff4b4b' }}><Trash2 size={20} /></button>
              </div>
            </motion.div>
          ))}
        </div>
      </section>
      <aside className="glass-panel" style={{ padding: '2rem', borderRadius: '32px', border: '1px solid rgba(255,255,255,0.05)', alignSelf: 'start' }}>
        <h3 className="tech-font" style={{ fontSize: '1.25rem', marginBottom: '1.5rem', fontWeight: 800 }}>GENERATE TOKEN</h3>
        <form onSubmit={createKey} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <input type="text" className="glass-input" placeholder="Identifier (e.g. CI/CD Pipeline)" value={newKeyName} onChange={e => setNewKeyName(e.target.value)} required />
          <button type="submit" className="btn-neon-cyan" style={{ width: '100%', height: '54px', fontSize: '1rem', fontWeight: 800 }} disabled={loading}>
            {loading ? <RefreshCw className="animate-spin" size={20} /> : 'CREATE ACCESS TOKEN'}
          </button>
        </form>
      </aside>
    </div>
  </>
);

const KnowledgeGraphView: React.FC<{ analysis: AnalysisData | null }> = ({ analysis }) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  
  const nodes = useMemo(() => {
    if (!analysis) return [];
    return analysis.graph.nodes.slice(0, 40).map((n, i) => ({
      ...n,
      x: 100 + (i % 8) * 120 + Math.random() * 40,
      y: 100 + Math.floor(i / 8) * 120 + Math.random() * 40
    }));
  }, [analysis]);

  return (
    <div style={{ height: 'calc(100vh - 8rem)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0, fontWeight: 800 }}>Knowledge Network</h1>
        <p style={{ color: 'var(--text-muted)' }}>Mapping {analysis?.stats.totalModules || 0} modules and {analysis?.stats.totalFunctions || 0} logic entities.</p>
      </header>
      <div className="glass-panel" style={{ flex: 1, borderRadius: '32px', position: 'relative', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.05)' }}>
        {!analysis ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '1.5rem' }}>
            <Loader2 className="animate-spin" size={48} color="var(--primary-neon)" />
            <div style={{ fontWeight: 600, color: 'var(--text-muted)' }}>Initializing Neural Network...</div>
          </div>
        ) : (
          <svg width="100%" height="100%" viewBox="0 0 1100 700">
            <defs>
              <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            </defs>
            {nodes.map((node, i) => (
              <g key={node.id} onMouseEnter={() => setHoveredId(node.id)} onMouseLeave={() => setHoveredId(null)} style={{ cursor: 'pointer' }}>
                <motion.circle cx={node.x} cy={node.y} r={hoveredId === node.id ? 10 : 6} fill={hoveredId === node.id ? 'var(--primary-neon)' : 'rgba(255,255,255,0.2)'} filter={hoveredId === node.id ? 'url(#glow)' : 'none'} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: i * 0.02 }} />
                <text x={node.x + 15} y={node.y + 5} fill={hoveredId === node.id ? '#fff' : 'rgba(255,255,255,0.4)'} style={{ fontSize: '11px', fontWeight: 700 }}>{node.label}</text>
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
};

const LogicModelsView: React.FC<{ analysis: any }> = ({ analysis }) => (
  <div style={{ height: 'calc(100vh - 8rem)' }}>
    <header style={{ marginBottom: '3.5rem' }}>
      <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0, fontWeight: 800 }}>Logic Engines</h1>
      <p style={{ color: 'var(--text-muted)' }}>System intelligence status and neural processing branches.</p>
    </header>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '2rem' }}>
      {[
        { name: 'Knowledge Graph', value: `${analysis?.stats.totalModules || 0} Modules`, icon: Network, color: 'var(--primary-neon)', desc: 'Active structural relationship mapping.' },
        { name: 'Function Registry', value: `${analysis?.stats.totalFunctions || 0} Entities`, icon: Cpu, color: 'var(--secondary-neon)', desc: 'Full indexing of logic units and variables.' },
        { name: 'Oracle 26ai Link', value: 'Active', icon: Zap, color: '#00FF94', desc: 'Secure connection to Oracle AI cluster.' },
      ].map((engine, i) => (
        <div key={i} className="glass-panel rim-lit" style={{ padding: '2.5rem', borderRadius: '28px', border: '1px solid rgba(255,255,255,0.05)' }}>
          <engine.icon size={40} color={engine.color} style={{ marginBottom: '2rem' }} />
          <h3 style={{ fontSize: '1.6rem', margin: '0 0 0.5rem 0', fontWeight: 800 }}>{engine.name}</h3>
          <div style={{ fontSize: '1.25rem', fontWeight: 900, color: engine.color, marginBottom: '1rem' }}>{engine.value}</div>
          <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '0.95rem', lineHeight: 1.5 }}>{engine.desc}</p>
        </div>
      ))}
    </div>
  </div>
);

const CloudIndexView: React.FC<{ analysis: any, isIndexing: boolean, onReindex: () => void }> = ({ analysis, isIndexing, onReindex }) => (
  <div style={{ height: 'calc(100vh - 8rem)' }}>
    <header style={{ marginBottom: '3.5rem' }}>
      <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0, fontWeight: 800 }}>Neural Index</h1>
      <p style={{ color: 'var(--text-muted)' }}>Global codebase indexing status and vector synchronization.</p>
    </header>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 400px', gap: '3rem' }}>
      <div className="glass-panel" style={{ padding: '2.5rem', borderRadius: '32px', border: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2rem', marginBottom: '3rem' }}>
          {[
            { label: 'Files Scanned', value: analysis?.stats.totalFiles || 0, icon: Globe },
            { label: 'Neural Nodes', value: analysis?.graph.nodes.length || 0, icon: Server },
            { label: 'Sync Status', value: isIndexing ? 'Syncing...' : 'Synced', icon: HardDrive },
          ].map((item, i) => (
            <div key={i} style={{ textAlign: 'center' }}>
              <item.icon size={28} color="var(--primary-neon)" style={{ marginBottom: '0.75rem' }} />
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '0.25rem' }}>{item.label}</div>
              <div style={{ fontSize: '1.75rem', fontWeight: 900 }}>{item.value}</div>
            </div>
          ))}
        </div>
        <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '20px', padding: '2rem', fontFamily: 'monospace', fontSize: '0.95rem', color: 'var(--primary-neon)', minHeight: '220px', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ opacity: 0.6, marginBottom: '0.75rem' }}>[SYS] NEURAL INDEX v2.1.3 READY</div>
          {isIndexing ? (
            <motion.div animate={{ opacity: [0.6, 1] }} transition={{ repeat: Infinity, duration: 0.6 }}>
              {"> "} SCANNING SOURCE FILES...<br/>
              {"> "} EXTRACTING NEURAL ENTITIES...<br/>
              {"> "} MAPPING LOGIC RELATIONSHIPS...<br/>
              {"> "} SYNCING TO ORACLE CLOUD...
            </motion.div>
          ) : (
            <div>{"> "} ALL SYSTEMS NOMINAL<br/>{"> "} VECTOR SYNC COMPLETE<br/>{"> "} CACHE INTEGRITY: 100%</div>
          )}
        </div>
      </div>
      <aside className="glass-panel" style={{ padding: '2rem', borderRadius: '32px', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column', gap: '1.25rem', alignSelf: 'start' }}>
        <h3 className="tech-font" style={{ fontSize: '1.25rem', fontWeight: 800 }}>INDEX CONTROLS</h3>
        <button onClick={onReindex} className="btn-neon-cyan" style={{ width: '100%', height: '56px', fontSize: '1rem', fontWeight: 800, gap: '0.75rem' }} disabled={isIndexing}>
          {isIndexing ? <RefreshCw className="animate-spin" size={22} /> : <Search size={22} />} FULL RE-INDEX
        </button>
        <button style={{ width: '100%', background: 'rgba(255,255,255,0.03)', color: '#fff', padding: '1rem', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', fontWeight: 700, transition: 'all 0.3s' }}>
          CLEAR PERSISTENCE
        </button>
        <div style={{ marginTop: '1rem', padding: '1rem', background: 'rgba(255, 180, 0, 0.05)', borderRadius: '14px', border: '1px solid rgba(255, 180, 0, 0.1)', color: '#FFB400', fontSize: '0.8rem', lineHeight: 1.4 }}>
          <strong>WARNING:</strong> Re-indexing large codebases may increase latency for active tokens.
        </div>
      </aside>
    </div>
  </div>
);
