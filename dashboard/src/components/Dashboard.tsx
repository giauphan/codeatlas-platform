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

// API Configuration
const API_BASE = window.location.origin.includes('localhost') 
  ? 'http://localhost:8080' 
  : window.location.origin.replace('://', '://api.'); // Fallback pattern

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
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [isIndexing, setIsIndexing] = useState(false);
  const [stats, setStats] = useState({ totalRequests: 0 });
  const [activities, setActivities] = useState<any[]>([]);
  const user = auth.currentUser;

  // Fetch Real Analysis Data
  const fetchAnalysis = async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/analysis`, {
        headers: { 'x-api-key': SUPER_ADMIN_KEY }
      });
      if (resp.ok) {
        const data = await resp.json();
        setAnalysis(data);
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
      if (resp.ok) {
        await fetchAnalysis();
      }
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
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--background)', color: '#fff' }}>
      <aside className="sidebar glass-panel rim-lit" style={{ width: '280px', padding: '2rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <div style={{ width: '40px', height: '40px', background: 'var(--primary-neon)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--glow-primary)' }}>
            <ShieldCheck size={24} color="#000" />
          </div>
          <span className="tech-font" style={{ fontSize: '1.4rem', fontWeight: 800 }}>CODEATLAS</span>
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {[
            { icon: LayoutDashboard, label: 'Control Center' },
            { icon: Network, label: 'Knowledge Graph' },
            { icon: Cpu, label: 'Logic Models' },
            { icon: Globe, label: 'Cloud Index' },
          ].map((item) => (
            <div
              key={item.label}
              onClick={() => setActiveTab(item.label)}
              style={{
                display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.875rem 1rem', borderRadius: '12px', cursor: 'pointer',
                background: activeTab === item.label ? 'rgba(0, 240, 255, 0.1)' : 'transparent',
                color: activeTab === item.label ? 'var(--primary-neon)' : 'var(--text-muted)',
                border: activeTab === item.label ? '1px solid rgba(0, 240, 255, 0.2)' : '1px solid transparent',
              }}
            >
              <item.icon size={20} />
              <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>{item.label}</span>
            </div>
          ))}
        </nav>
        <div style={{ marginTop: 'auto', padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '16px' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>ENTERPRISE NODE</div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{user?.email}</div>
          <button onClick={() => auth.signOut()} style={{ marginTop: '1rem', color: '#ff4b4b', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.85rem' }}>
            <LogOut size={16} /> SIGN OUT
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, padding: '2.5rem 3rem', overflowY: 'auto' }}>
        <AnimatePresence mode="wait">
          <motion.div key={activeTab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
};

const ControlCenterView: React.FC<any> = ({ stats, keys, analysis, createKey, deleteKey, copyToClipboard, copiedId, newKeyName, setNewKeyName, loading }) => (
  <>
    <header style={{ marginBottom: '3rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <h1 style={{ fontSize: '3rem', margin: 0, fontWeight: 800 }} className="tech-font">Neural Control</h1>
        <p style={{ color: 'var(--text-muted)' }}>Managing enterprise intelligence & neural access tokens.</p>
      </div>
      <div style={{ padding: '0.5rem 1rem', borderRadius: '8px', background: 'rgba(157, 0, 255, 0.1)', border: '1px solid var(--secondary-neon)', color: 'var(--secondary-neon)', fontWeight: 700 }}>
        v2.1.3 ONLINE
      </div>
    </header>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '3rem' }}>
      {[
        { label: 'Total Requests', value: stats.totalRequests.toLocaleString(), icon: Activity, color: 'var(--primary-neon)' },
        { label: 'Neural Entities', value: analysis?.stats.totalFunctions.toLocaleString() || '---', icon: Database, color: 'var(--secondary-neon)' },
        { label: 'Codebase (LOC)', value: analysis?.stats.loc.toLocaleString() || '---', icon: Terminal, color: '#00FF94' },
      ].map((stat, i) => (
        <div key={i} className="glass-panel" style={{ padding: '1.5rem', borderRadius: '20px' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{stat.label}</div>
          <div style={{ fontSize: '2.2rem', fontWeight: 800, marginTop: '0.5rem' }}>{stat.value}</div>
        </div>
      ))}
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '2.5rem' }}>
      <section>
        <h2 className="tech-font" style={{ fontSize: '1.4rem', marginBottom: '1.5rem' }}>ACTIVE TOKENS</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {keys.map((k: any) => (
            <div key={k.id} className="glass-panel rim-lit" style={{ padding: '1.25rem', borderRadius: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{k.name}</div>
                <code style={{ color: 'var(--primary-neon)', fontSize: '0.9rem' }}>{k.key}</code>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={() => copyToClipboard(k.key, k.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copiedId === k.id ? 'var(--primary-neon)' : '#fff' }}>
                  {copiedId === k.id ? <Check size={18} /> : <Copy size={18} />}
                </button>
                <button onClick={() => deleteKey(k.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#ff4b4b' }}><Trash2 size={18} /></button>
              </div>
            </div>
          ))}
        </div>
      </section>
      <aside className="glass-panel" style={{ padding: '1.5rem', borderRadius: '24px' }}>
        <h3 className="tech-font" style={{ fontSize: '1.1rem', marginBottom: '1.5rem' }}>GENERATE TOKEN</h3>
        <form onSubmit={createKey} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <input type="text" className="glass-input" placeholder="Identifier (e.g. CI/CD)" value={newKeyName} onChange={e => setNewKeyName(e.target.value)} required />
          <button type="submit" className="btn-neon-cyan" style={{ width: '100%' }} disabled={loading}>{loading ? <RefreshCw className="animate-spin" size={18} /> : 'CREATE'}</button>
        </form>
      </aside>
    </div>
  </>
);

const KnowledgeGraphView: React.FC<{ analysis: AnalysisData | null }> = ({ analysis }) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  
  const nodes = useMemo(() => {
    if (!analysis) return [];
    // Take first 30 entities for visualization
    return analysis.graph.nodes.slice(0, 30).map((n, i) => ({
      ...n,
      x: 100 + (i % 6) * 150 + Math.random() * 50,
      y: 100 + Math.floor(i / 6) * 120 + Math.random() * 40
    }));
  }, [analysis]);

  return (
    <div style={{ height: 'calc(100vh - 10rem)' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0 }}>Knowledge Network</h1>
        <p style={{ color: 'var(--text-muted)' }}>Mapping {analysis?.stats.totalModules || 0} modules and {analysis?.stats.totalFunctions || 0} functions.</p>
      </header>
      <div className="glass-panel" style={{ height: '100%', borderRadius: '32px', position: 'relative', overflow: 'hidden' }}>
        {!analysis ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
            <Loader2 className="animate-spin" size={48} />
          </div>
        ) : (
          <svg width="100%" height="100%" viewBox="0 0 1100 700">
            <defs>
              <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
            </defs>
            {nodes.map((node, i) => (
              <g key={node.id} onMouseEnter={() => setHoveredId(node.id)} onMouseLeave={() => setHoveredId(null)} style={{ cursor: 'pointer' }}>
                <motion.circle cx={node.x} cy={node.y} r={hoveredId === node.id ? 10 : 6} fill={hoveredId === node.id ? 'var(--primary-neon)' : 'rgba(255,255,255,0.2)'} filter={hoveredId === node.id ? 'url(#glow)' : 'none'} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: i * 0.05 }} />
                <text x={node.x + 12} y={node.y + 5} fill={hoveredId === node.id ? '#fff' : 'rgba(255,255,255,0.4)'} style={{ fontSize: '11px', fontWeight: 600 }}>{node.name.split('/').pop()}</text>
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
};

const LogicModelsView: React.FC<{ analysis: any }> = ({ analysis }) => (
  <div style={{ height: 'calc(100vh - 10rem)' }}>
    <header style={{ marginBottom: '3rem' }}>
      <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0 }}>Logic Engines</h1>
      <p style={{ color: 'var(--text-muted)' }}>System intelligence status and neural processing power.</p>
    </header>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1.5rem' }}>
      {[
        { name: 'Knowledge Graph', value: `${analysis?.stats.totalModules || 0} Modules`, icon: Network, color: 'var(--primary-neon)' },
        { name: 'Function Registry', value: `${analysis?.stats.totalFunctions || 0} Entities`, icon: Cpu, color: 'var(--secondary-neon)' },
        { name: 'Oracle 26ai Link', value: 'Active', icon: Zap, color: '#00FF94' },
      ].map((engine, i) => (
        <div key={i} className="glass-panel rim-lit" style={{ padding: '2rem', borderRadius: '24px' }}>
          <engine.icon size={32} color={engine.color} style={{ marginBottom: '1.5rem' }} />
          <h3 style={{ fontSize: '1.4rem', margin: '0 0 0.5rem 0' }}>{engine.name}</h3>
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: engine.color }}>{engine.value}</div>
        </div>
      ))}
    </div>
  </div>
);

const CloudIndexView: React.FC<{ analysis: any, isIndexing: boolean, onReindex: () => void }> = ({ analysis, isIndexing, onReindex }) => (
  <div style={{ height: 'calc(100vh - 10rem)' }}>
    <header style={{ marginBottom: '3rem' }}>
      <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0 }}>Neural Index</h1>
      <p style={{ color: 'var(--text-muted)' }}>Repository indexing status and vector synchronization.</p>
    </header>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '2.5rem' }}>
      <div className="glass-panel" style={{ padding: '2rem', borderRadius: '32px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '2rem' }}>
          {[
            { label: 'Files', value: analysis?.stats.totalFiles || 0, icon: Globe },
            { label: 'Neural Nodes', value: analysis?.graph.nodes.length || 0, icon: Server },
            { label: 'Status', value: isIndexing ? 'Syncing...' : 'Synced', icon: HardDrive },
          ].map((item, i) => (
            <div key={i} style={{ textAlign: 'center' }}>
              <item.icon size={24} color="var(--primary-neon)" style={{ marginBottom: '0.5rem' }} />
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{item.label}</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{item.value}</div>
            </div>
          ))}
        </div>
        <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '16px', padding: '1.5rem', fontFamily: 'monospace', fontSize: '0.85rem', color: 'var(--primary-neon)', minHeight: '200px' }}>
          <div>[SYS] NEURAL INDEX v2.1.3 READY</div>
          {isIndexing ? (
            <motion.div animate={{ opacity: [0.5, 1] }} transition={{ repeat: Infinity, duration: 0.5 }}>
              {"> "} SCANNING CODEBASE...<br/>
              {"> "} ANALYZING ENTITIES...<br/>
              {"> "} MAPPING RELATIONSHIPS...
            </motion.div>
          ) : (
            <div>{"> "} ALL SYSTEMS NOMINAL<br/>{"> "} VECTOR SYNC COMPLETE</div>
          )}
        </div>
      </div>
      <aside className="glass-panel" style={{ padding: '2rem', borderRadius: '32px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h3 className="tech-font" style={{ fontSize: '1.1rem' }}>INDEX CONTROLS</h3>
        <button onClick={onReindex} className="btn-neon-cyan" style={{ width: '100%', gap: '0.5rem' }} disabled={isIndexing}>
          {isIndexing ? <RefreshCw className="animate-spin" size={18} /> : <Search size={18} />} FULL RE-INDEX
        </button>
        <button style={{ width: '100%', background: 'rgba(255,255,255,0.05)', color: '#fff', padding: '0.75rem', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer' }}>
          CLEAR PERSISTENCE
        </button>
      </aside>
    </div>
  </div>
);
