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
  Terminal,
  Filter,
  Layers,
  Code2,
  Box
} from 'lucide-react';

// API Configuration
const API_BASE = window.location.origin.includes('localhost') 
  ? 'http://localhost:8080' 
  : window.location.origin;

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
  const [isIndexingEnabled, setIsIndexingEnabled] = useState(() => {
    const saved = localStorage.getItem('codeatlas_indexing_enabled');
    return saved !== null ? JSON.parse(saved) : true;
  });

  useEffect(() => {
    localStorage.setItem('codeatlas_indexing_enabled', JSON.stringify(isIndexingEnabled));
  }, [isIndexingEnabled]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [stats, setStats] = useState({ totalRequests: 0 });
  const user = auth.currentUser;

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
        return <CloudIndexView analysis={analysis} isIndexing={isIndexing} onReindex={handleReindex} isIndexingEnabled={isIndexingEnabled} setIsIndexingEnabled={setIsIndexingEnabled} />;
      default:
        return null;
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--background)', color: '#fff', overflow: 'hidden' }}>
      
      {/* SIDEBAR */}
      <aside className="glass-panel" style={{ 
        width: '300px', minWidth: '300px', padding: '2.5rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '2.5rem',
        borderRight: '1px solid rgba(255,255,255,0.1)', height: '100vh', boxSizing: 'border-box'
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

      {/* MAIN AREA */}
      <main style={{ flex: 1, height: '100vh', overflowY: 'auto', padding: '3rem 4rem', boxSizing: 'border-box' }}>
        <AnimatePresence mode="wait">
          <motion.div key={activeTab} initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.3 }}>
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>

      <style>{`
        .glass-panel { background: rgba(13, 17, 23, 0.7); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
        .tech-font { font-family: 'Inter', system-ui, -apple-system, sans-serif; letter-spacing: -0.02em; }
        .glass-input { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 0.875rem 1rem; border-radius: 12px; width: 100%; transition: all 0.3s; }
        .glass-input:focus { outline: none; border-color: var(--primary-neon); box-shadow: 0 0 15px rgba(0, 240, 255, 0.1); }
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .filter-chip { padding: 0.5rem 1rem; border-radius: 10px; background: rgba(255,255,255,0.05); cursor: pointer; border: 1px solid transparent; font-size: 0.8rem; font-weight: 700; transition: all 0.3s; color: var(--text-muted); display: flex; alignItems: center; gap: 0.5rem; }
        .filter-chip.active { background: rgba(0, 240, 255, 0.1); border-color: var(--primary-neon); color: var(--primary-neon); }
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
      <div style={{ padding: '0.65rem 1.25rem', borderRadius: '10px', background: 'rgba(0, 240, 255, 0.1)', border: '1px solid var(--primary-neon)', color: 'var(--primary-neon)', fontWeight: 800, fontSize: '0.9rem' }}>
        v2.1.4 ONLINE
      </div>
    </header>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '2rem', marginBottom: '4rem' }}>
      {[
        { label: 'Total Requests', value: stats.totalRequests.toLocaleString(), icon: Activity, color: 'var(--primary-neon)' },
        { label: 'Neural Entities', value: (analysis?.stats?.totalFunctions || analysis?.stats?.totalClasses || analysis?.entityCounts?.functions || 0).toLocaleString(), icon: Database, color: 'var(--secondary-neon)' },
        { label: 'Scanned Files', value: (analysis?.totalFilesAnalyzed || analysis?.stats?.totalFiles || 0).toLocaleString(), icon: Globe, color: '#00FF94' },
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
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState(['module', 'function', 'class', 'variable']);
  
  const filteredNodes = useMemo(() => {
    if (!analysis) return [];
    return analysis.graph.nodes.filter(n => {
      const typeMatch = activeFilters.includes(n.type || 'function');
      const searchMatch = n.label.toLowerCase().includes(searchQuery.toLowerCase());
      return typeMatch && searchMatch;
    });
  }, [analysis, searchQuery, activeFilters]);

  const nodes = useMemo(() => {
    if (filteredNodes.length === 0) return [];
    
    // Logic Layout Cụm (Cluster-based Layout)
    const centerX = 550;
    const centerY = 350;
    
    return filteredNodes.slice(0, 150).map((n, i) => {
      const isModule = n.type === 'module';
      const angle = (i * 2 * Math.PI) / (isModule ? 10 : 30);
      const radius = isModule ? 80 : 200 + (Math.floor(i/30) * 80);
      
      return {
        ...n,
        x: centerX + Math.cos(angle) * radius + (Math.sin(i) * 20),
        y: centerY + Math.sin(angle) * radius + (Math.cos(i) * 20)
      };
    });
  }, [filteredNodes]);

  const links = useMemo(() => {
    if (!analysis || nodes.length === 0) return [];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    return analysis.graph.links
      .filter(l => nodeMap.has(l.source) && nodeMap.has(l.target))
      .map(l => ({
        source: nodeMap.get(l.source),
        target: nodeMap.get(l.target)
      }));
  }, [analysis, nodes]);

  const toggleFilter = (type: string) => {
    setActiveFilters(prev => prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]);
  };

  return (
    <div style={{ height: 'calc(100vh - 8rem)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0, fontWeight: 800 }}>Knowledge Network</h1>
          <p style={{ color: 'var(--text-muted)' }}>Interactive neural mapping of <span style={{ color: 'var(--primary-neon)' }}>{analysis?.stats?.totalModules || 0}</span> logic clusters.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          {[
            { id: 'module', label: 'Modules', icon: Box, color: '#00F0FF' },
            { id: 'function', label: 'Functions', icon: Code2, color: '#FF00A8' },
            { id: 'class', label: 'Classes', icon: Layers, color: '#FFB400' },
            { id: 'variable', label: 'Variables', icon: Activity, color: '#00FF94' },
          ].map(f => (
            <div key={f.id} className={`filter-chip ${activeFilters.includes(f.id) ? 'active' : ''}`} onClick={() => toggleFilter(f.id)}>
              <f.icon size={14} /> {f.label}
            </div>
          ))}
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '2rem', flex: 1, minHeight: 0 }}>
        {/* Graph Area */}
        <div className="glass-panel" style={{ borderRadius: '32px', position: 'relative', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(5, 8, 15, 0.6)' }}>
          <div style={{ position: 'absolute', top: '2rem', left: '2rem', zIndex: 10, width: '350px' }}>
            <div style={{ position: 'relative' }}>
              <Search size={18} style={{ position: 'absolute', left: '1rem', top: '1rem', color: 'var(--text-muted)' }} />
              <input type="text" className="glass-input" placeholder="Search functions, modules..." style={{ paddingLeft: '3rem', background: 'rgba(0,0,0,0.5)' }} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            </div>
          </div>

          <svg width="100%" height="100%" viewBox="0 0 1100 700">
            <defs>
              <filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
              <linearGradient id="linkGradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="rgba(0, 240, 255, 0.1)" /><stop offset="100%" stopColor="rgba(157, 0, 255, 0.1)" /></linearGradient>
            </defs>
            {links.map((link, i) => (
              <motion.line key={`link-${i}`} x1={link.source.x} y1={link.source.y} x2={link.target.x} y2={link.target.y} stroke="url(#linkGradient)" strokeWidth="1" initial={{ opacity: 0 }} animate={{ opacity: 0.3 }} />
            ))}
            {nodes.map((node, i) => {
              const color = node.type === 'module' ? '#00F0FF' : node.type === 'class' ? '#FFB400' : '#FF00A8';
              return (
                <g key={node.id} onMouseEnter={() => setHoveredId(node.id)} onMouseLeave={() => setHoveredId(null)} style={{ cursor: 'pointer' }}>
                  <motion.circle cx={node.x} cy={node.y} r={hoveredId === node.id ? 10 : node.type === 'module' ? 8 : 4} fill={hoveredId === node.id ? color : `${color}66`} filter={hoveredId === node.id ? 'url(#glow)' : 'none'} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: i * 0.005 }} />
                  {(hoveredId === node.id || node.type === 'module') && (
                    <text x={node.x + 15} y={node.y + 5} fill="#fff" style={{ fontSize: node.type === 'module' ? '12px' : '10px', fontWeight: 800, pointerEvents: 'none', textShadow: '0 0 10px #000' }}>{node.label}</text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Stats Sidebar */}
        <div className="glass-panel" style={{ borderRadius: '32px', padding: '2rem', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          <h3 className="tech-font" style={{ fontSize: '1.25rem', fontWeight: 800 }}>Entity Overview</h3>
          {[
            { label: 'Modules', count: analysis?.stats?.totalModules || 0, icon: Box, color: '#00F0FF' },
            { label: 'Functions', count: analysis?.stats?.totalFunctions || 0, icon: Code2, color: '#FF00A8' },
            { label: 'Classes', count: analysis?.stats?.totalClasses || 0, icon: Layers, color: '#FFB400' },
            { label: 'Variables', count: analysis?.stats?.totalVariables || 0, icon: Activity, color: '#00FF94' },
          ].map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', background: 'rgba(255,255,255,0.03)', padding: '1.25rem', borderRadius: '18px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ width: '40px', height: '40px', background: `${item.color}15`, borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: item.color }}><item.icon size={20} /></div>
              <div>
                <div style={{ fontSize: '1.5rem', fontWeight: 900 }}>{item.count}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700 }}>{item.label}</div>
              </div>
            </div>
          ))}
          <div style={{ marginTop: 'auto', padding: '1.5rem', background: 'rgba(0, 240, 255, 0.05)', borderRadius: '20px', border: '1px solid rgba(0, 240, 255, 0.1)' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--primary-neon)', marginBottom: '0.5rem' }}>INDEX COVERAGE</div>
            <div style={{ height: '8px', background: 'rgba(0,0,0,0.3)', borderRadius: '10px', overflow: 'hidden' }}>
              <motion.div initial={{ width: 0 }} animate={{ width: '85%' }} transition={{ duration: 1 }} style={{ height: '100%', background: 'var(--primary-neon)', boxShadow: '0 0 10px var(--primary-neon)' }} />
            </div>
            <div style={{ textAlign: 'right', fontSize: '0.7rem', marginTop: '0.5rem', color: 'var(--primary-neon)', fontWeight: 800 }}>85% SCANNED</div>
          </div>
        </div>
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
        { name: 'Knowledge Graph', value: `${analysis?.stats?.totalModules || 0} Modules`, icon: Network, color: 'var(--primary-neon)', desc: 'Active structural relationship mapping.' },
        { name: 'Function Registry', value: `${analysis?.stats?.totalFunctions || 0} Entities`, icon: Cpu, color: 'var(--secondary-neon)', desc: 'Full indexing of logic units and variables.' },
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

const CloudIndexView: React.FC<{ analysis: any, isIndexing: boolean, onReindex: () => void, isIndexingEnabled: boolean, setIsIndexingEnabled: (v: boolean) => void }> = ({ analysis, isIndexing, onReindex, isIndexingEnabled, setIsIndexingEnabled }) => {
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <div style={{ height: 'calc(100vh - 8rem)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0, fontWeight: 800 }}>Neural Indexing</h1>
        <p style={{ color: 'var(--text-muted)' }}>Configure codebase indexing settings to enable structural and semantic search.</p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '3rem', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          
          {/* MAIN INDEXING PANEL (ROO-CODE STYLE) */}
          <div className="glass-panel" style={{ padding: '2.5rem', borderRadius: '24px', border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(13, 17, 23, 0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', marginBottom: '2.5rem' }}>
              <div style={{ 
                width: '24px', height: '24px', border: '2px solid var(--primary-neon)', borderRadius: '6px', 
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                background: isIndexingEnabled ? 'var(--primary-neon)' : 'transparent'
              }} onClick={() => setIsIndexingEnabled(!isIndexingEnabled)}>
                {isIndexingEnabled && <Check size={16} color="#000" strokeWidth={4} />}
              </div>
              <span style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff' }}>Enable Codebase Indexing</span>
              <div style={{ padding: '0.25rem 0.6rem', borderRadius: '100px', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                <Activity size={12} style={{ display: 'inline', marginRight: '4px' }} /> i
              </div>
            </div>

            <div style={{ marginBottom: '2.5rem' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '0.75rem', textTransform: 'uppercase' }}>Status</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ 
                  width: '12px', height: '12px', borderRadius: '50%', 
                  background: isIndexing ? 'var(--primary-neon)' : 'rgba(255,255,255,0.2)',
                  boxShadow: isIndexing ? '0 0 10px var(--primary-neon)' : 'none'
                }} />
                <span style={{ fontWeight: 600, color: isIndexing ? '#fff' : 'var(--text-muted)' }}>
                  {isIndexing ? 'Scanning source files...' : isIndexingEnabled ? 'Standby - Watching for changes' : 'Code indexing is disabled'}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div style={{ cursor: 'pointer' }} onClick={() => setShowAdvanced(!showAdvanced)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', color: '#fff', fontWeight: 700 }}>
                  <motion.div animate={{ rotate: showAdvanced ? 90 : 0 }}>{"> "}</motion.div> Setup
                </div>
              </div>
              
              <div style={{ cursor: 'pointer' }} onClick={() => setShowAdvanced(!showAdvanced)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', color: '#fff', fontWeight: 700 }}>
                  <motion.div animate={{ rotate: showAdvanced ? 90 : 0 }}>{"> "}</motion.div> Advanced Configuration
                </div>
              </div>

              {showAdvanced && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} style={{ padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '12px', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                  Indexing Depth: Level 4 (Full Analysis)<br/>
                  Exclusions: node_modules, .git, build, dist<br/>
                  Target: /home/biibon/CodeAtlas
                </motion.div>
              )}
            </div>

            <div style={{ marginTop: '3rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn-neon-cyan" style={{ padding: '0.75rem 2rem' }} onClick={onReindex} disabled={isIndexing}>
                {isIndexing ? <Loader2 className="animate-spin" size={20} /> : 'Save & Index Now'}
              </button>
            </div>
          </div>

          {/* LOG CONSOLE */}
          <div className="glass-panel" style={{ flex: 1, padding: '1.5rem', borderRadius: '24px', background: '#05080f', border: '1px solid rgba(255,255,255,0.05)', fontFamily: 'monospace' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--primary-neon)' }}>INDEXING_LOG_STREAM</span>
              <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)' }}>NODE_01</span>
            </div>
            <div style={{ fontSize: '0.9rem', color: 'rgba(0, 240, 255, 0.8)', lineHeight: 1.6 }}>
              {isIndexing ? (
                <motion.div animate={{ opacity: [0.5, 1] }} transition={{ repeat: Infinity, duration: 0.8 }}>
                  [SCAN] Crawling directory structure...<br/>
                  [PARS] Analyzing 286 AST nodes...<br/>
                  [GRAPH] Updating Knowledge Network links...<br/>
                  [EMBED] Generating semantic vectors...
                </motion.div>
              ) : (
                <>
                  [READY] System monitoring active<br/>
                  [INFO] Last index: {new Date().toLocaleTimeString()}<br/>
                  [INFO] Vector database synchronized (85% coverage)
                </>
              )}
            </div>
          </div>
        </div>

        {/* SIDEBAR STATS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="glass-panel" style={{ padding: '2rem', borderRadius: '28px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <h3 className="tech-font" style={{ fontSize: '1.1rem', marginBottom: '1.5rem', fontWeight: 800 }}>Index Statistics</h3>
            {[
              { label: 'Scanned Files', value: analysis?.totalFilesAnalyzed || analysis?.stats?.totalFiles || 0, icon: Globe },
              { label: 'Neural Nodes', value: analysis?.graph?.nodes?.length || 0, icon: Server },
              { label: 'Logic Units', value: analysis?.stats?.totalFunctions || analysis?.stats?.totalClasses || analysis?.entityCounts?.functions || 0, icon: Cpu },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
                <div style={{ color: 'var(--primary-neon)' }}><item.icon size={20} /></div>
                <div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 900 }}>{item.value}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>{item.label}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="glass-panel" style={{ padding: '1.5rem', borderRadius: '24px', background: 'rgba(255, 180, 0, 0.05)', border: '1px solid rgba(255, 180, 0, 0.1)' }}>
            <div style={{ color: '#FFB400', fontSize: '0.8rem', fontWeight: 800, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Zap size={14} /> ADVISORY
            </div>
            <p style={{ fontSize: '0.8rem', color: 'rgba(255, 180, 0, 0.8)', margin: 0, lineHeight: 1.4 }}>
              Automatic indexing is optimized for local development. For large enterprise monorepos, use the "Selective Scan" in Advanced Configuration.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
