import React, { useState, useEffect } from 'react';
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
  Clock,
  ShieldCheck,
  Loader2,
  LayoutDashboard,
  Database,
  Cpu,
  Globe,
  Zap,
  Network
} from 'lucide-react';

interface ApiKey {
  id: string;
  name: string;
  key: string;
  tier: string;
  createdAt: any;
  lastUsed: any;
}

export const Dashboard: React.FC = () => {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [userTier] = useState<string>('enterprise');
  const [stats, setStats] = useState({ totalRequests: 0, lastActivity: null });
  const [activities, setActivities] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState('Control Center');
  const user = auth.currentUser;

  useEffect(() => {
    if (!user) return;

    const unsubscribeStats = onSnapshot(doc(db, 'users', user.uid), (docSnapshot: any) => {
      if (docSnapshot.exists() && docSnapshot.data().stats) {
        setStats(docSnapshot.data().stats);
      }
    });

    const actQuery = query(
      collection(db, 'users', user.uid, 'activity'),
      orderBy('timestamp', 'desc'),
      limit(10)
    );
    const unsubscribeActivities = onSnapshot(actQuery, (snapshot: any) => {
      const actData = snapshot.docs.map((doc: any) => ({
        id: doc.id,
        ...doc.data()
      }));
      setActivities(actData);
    });

    const q = query(
      collection(db, 'users', user.uid, 'keys'),
      orderBy('createdAt', 'desc')
    );

    const unsubscribeKeys = onSnapshot(q, (snapshot: any) => {
      const keysData = snapshot.docs.map((doc: any) => ({
        id: doc.id,
        ...doc.data()
      })) as ApiKey[];
      setKeys(keysData);
    });

    return () => {
      unsubscribeStats();
      unsubscribeActivities();
      unsubscribeKeys();
    };
  }, [user]);

  const generateKey = () => {
    return 'ca_' + crypto.randomUUID().replace(/-/g, '');
  };

  const createKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newKeyName.trim()) return;

    setLoading(true);
    try {
      await addDoc(collection(db, 'users', user.uid, 'keys'), {
        name: newKeyName,
        key: generateKey(),
        tier: userTier,
        createdAt: serverTimestamp(),
        lastUsed: null
      });
      setNewKeyName('');
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const deleteKey = async (id: string) => {
    if (!user || !confirm('Confirm terminal key deletion? This action is irreversible.')) return;
    try {
      await deleteDoc(doc(db, 'users', user.uid, 'keys', id));
    } catch (err) {
      console.error(err);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--background)', overflow: 'hidden' }}>
      
      {/* SIDEBAR: Glassmorphism Navigation */}
      <aside className="sidebar glass-panel rim-lit" style={{ 
        padding: '2rem 1.5rem', 
        display: 'flex', 
        flexDirection: 'column',
        gap: '2.5rem',
        zIndex: 50,
        width: '280px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0 0.5rem' }}>
          <div style={{ 
            width: '40px', height: '40px', 
            background: 'var(--primary-neon)', 
            borderRadius: '12px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: 'var(--glow-primary)'
          }}>
            <ShieldCheck size={24} color="#000" />
          </div>
          <span className="tech-font" style={{ fontSize: '1.4rem', fontWeight: 800, color: '#fff' }}>
            CODEATLAS
          </span>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {[
            { icon: LayoutDashboard, label: 'Control Center' },
            { icon: Network, label: 'Knowledge Graph' },
            { icon: Cpu, label: 'Logic Models' },
            { icon: Globe, label: 'Cloud Index' },
          ].map((item, i) => (
            <motion.div
              key={i}
              whileHover={{ x: 5 }}
              onClick={() => setActiveTab(item.label)}
              style={{
                display: 'flex', alignItems: 'center', gap: '1rem',
                padding: '0.875rem 1rem', borderRadius: '12px',
                cursor: 'pointer',
                background: activeTab === item.label ? 'rgba(0, 240, 255, 0.1)' : 'transparent',
                color: activeTab === item.label ? 'var(--primary-neon)' : 'var(--text-muted)',
                border: activeTab === item.label ? '1px solid rgba(0, 240, 255, 0.2)' : '1px solid transparent',
                transition: 'all 0.3s ease'
              }}
            >
              <item.icon size={20} />
              <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>{item.label}</span>
            </motion.div>
          ))}
        </nav>

        <div style={{ marginTop: 'auto', padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '16px' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>LOGGED IN AS</div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.displayName || user?.email}</div>
          <button 
            onClick={() => auth.signOut()}
            style={{ 
              marginTop: '1rem', width: '100%', 
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              color: '#ff4b4b', background: 'transparent', border: 'none', cursor: 'pointer',
              fontSize: '0.85rem'
            }}>
            <LogOut size={16} /> SIGN OUT
          </button>
        </div>
      </aside>

      {/* MAIN CONTENT AREA */}
      <main className="main-content" style={{ flex: 1, padding: '2.5rem 3rem', overflowY: 'auto', position: 'relative' }}>
        
        <AnimatePresence mode="wait">
          {activeTab === 'Control Center' ? (
            <motion.div 
              key="control" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.3 }}
            >
              {/* Header Section */}
              <header style={{ marginBottom: '3rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <div>
                  <motion.h1 
                    initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}
                    style={{ fontSize: '3rem', margin: 0, fontWeight: 800 }} className="tech-font"
                  >
                    Control Center
                  </motion.h1>
                  <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                    Orchestrating enterprise intelligence & secure access tokens.
                  </p>
                </div>
                <div style={{ 
                  padding: '0.5rem 1rem', borderRadius: '8px', 
                  background: 'rgba(157, 0, 255, 0.1)', border: '1px solid var(--secondary-neon)',
                  color: 'var(--secondary-neon)', fontWeight: 700, fontSize: '0.8rem', letterSpacing: '0.05em'
                }}>
                  ENTERPRISE v2.1.3
                </div>
              </header>

              {/* Floating Stats Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '3rem' }}>
                {[
                  { label: 'Total Requests', value: stats.totalRequests.toLocaleString(), icon: Activity, color: 'var(--primary-neon)' },
                  { label: 'Neural Entities', value: '3,842', icon: Database, color: 'var(--secondary-neon)' },
                  { label: 'System Integrity', value: '100%', icon: ShieldCheck, color: '#00FF94' },
                ].map((stat, i) => (
                  <div key={i} className="glass-panel" style={{ padding: '1.5rem', borderRadius: '20px', position: 'relative', overflow: 'hidden' }}>
                    <stat.icon size={48} style={{ position: 'absolute', right: '-10px', bottom: '-10px', opacity: 0.05, color: stat.color }} />
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{stat.label}</div>
                    <div style={{ fontSize: '2.2rem', fontWeight: 800, marginTop: '0.5rem', color: '#fff' }}>{stat.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '2.5rem' }}>
                {/* API Keys List */}
                <section>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                    <h2 className="tech-font" style={{ fontSize: '1.4rem', margin: 0 }}>ACTIVE TOKENS</h2>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{keys.length} total keys</span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <AnimatePresence mode="popLayout">
                      {keys.map((apiKey) => (
                        <motion.div
                          key={apiKey.id} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}
                          className="glass-panel rim-lit"
                          style={{ padding: '1.5rem', borderRadius: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                        >
                          <div>
                            <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: '0.75rem' }}>{apiKey.name}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                              <code style={{ 
                                background: 'rgba(0,0,0,0.3)', padding: '0.5rem 1rem', borderRadius: '8px', 
                                color: 'var(--primary-neon)', fontFamily: 'monospace', fontSize: '0.95rem' 
                              }}>
                                {apiKey.key}
                              </code>
                              <button 
                                onClick={() => copyToClipboard(apiKey.key, apiKey.id)}
                                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: copiedId === apiKey.id ? 'var(--primary-neon)' : 'var(--text-muted)' }}
                              >
                                {copiedId === apiKey.id ? <Check size={18} /> : <Copy size={18} />}
                              </button>
                            </div>
                            <div style={{ marginTop: '1rem', display: 'flex', gap: '1.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                              <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <Clock size={14} /> {apiKey.createdAt?.toDate ? apiKey.createdAt.toDate().toLocaleDateString() : 'Just now'}
                              </span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <Zap size={14} /> {apiKey.lastUsed ? 'Recently used' : 'Unused'}
                              </span>
                            </div>
                          </div>
                          <button 
                            onClick={() => deleteKey(apiKey.id)}
                            className="hover-error"
                            style={{ padding: '0.75rem', borderRadius: '12px', color: '#475569', transition: 'all 0.2s', border: 'none', background: 'transparent', cursor: 'pointer' }}
                          >
                            <Trash2 size={20} />
                          </button>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                </section>

                <aside style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                  <section className="glass-panel" style={{ padding: '1.5rem', borderRadius: '24px' }}>
                    <h3 className="tech-font" style={{ fontSize: '1.1rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Plus size={20} /> NEW TERMINAL KEY
                    </h3>
                    <form onSubmit={createKey} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                      <input 
                        type="text" className="glass-input" placeholder="Identifier (e.g. VS Code)" 
                        value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} required
                      />
                      <button type="submit" className="btn-neon-cyan" style={{ width: '100%' }} disabled={loading}>
                        {loading ? <Loader2 className="animate-spin" size={20} /> : 'GENERATE TOKEN'}
                      </button>
                    </form>
                  </section>
                  
                  <section className="glass-panel" style={{ padding: '1.5rem', borderRadius: '24px', flex: 1 }}>
                    <h3 className="tech-font" style={{ fontSize: '1.1rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <Activity size={20} /> SYSTEM LOGS
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                      {activities.map((act) => (
                        <div key={act.id} style={{ display: 'flex', gap: '1rem', fontSize: '0.8rem' }}>
                          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: act.success !== false ? 'var(--primary-neon)' : 'var(--error)', marginTop: '4px', flexShrink: 0 }} />
                          <div>
                            <div style={{ fontWeight: 600, color: '#fff' }}>{act.tool}</div>
                            <div style={{ color: 'var(--text-muted)' }}>{act.timestamp?.toDate ? act.timestamp.toDate().toLocaleTimeString() : 'Recently'}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                </aside>
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="graph" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.02 }} transition={{ duration: 0.4 }}
            >
              <KnowledgeGraphView />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <style>{`
        .hover-error:hover { color: #ff4b4b !important; background: rgba(255, 75, 75, 0.1) !important; }
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

const KnowledgeGraphView: React.FC = () => {
  const [hoveredNode, setHoveredNode] = useState<number | null>(null);

  const nodes = [
    { id: 1, x: 250, y: 180, label: 'AuthManager.ts', type: 'class', connections: [2, 4] },
    { id: 2, x: 500, y: 120, label: 'SecureProxy.io', type: 'service', connections: [3, 5] },
    { id: 3, x: 750, y: 250, label: 'Oracle26ai_Core', type: 'engine', connections: [6] },
    { id: 4, x: 300, y: 450, label: 'VectorStore.db', type: 'database', connections: [5] },
    { id: 5, x: 550, y: 400, label: 'McpServer.ts', type: 'bridge', connections: [6] },
    { id: 6, x: 850, y: 500, label: 'NeuralLink.v1', type: 'interface', connections: [] },
  ];

  return (
    <div style={{ height: 'calc(100vh - 5rem)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ marginBottom: '2rem' }}>
        <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0 }}>Knowledge Network</h1>
        <p style={{ color: 'var(--text-muted)' }}>Real-time neural visualization of enterprise code intelligence.</p>
      </header>

      <div className="glass-panel" style={{ flex: 1, borderRadius: '32px', position: 'relative', overflow: 'hidden', background: 'radial-gradient(circle at center, rgba(0, 240, 255, 0.05) 0%, transparent 70%)' }}>
        <svg width="100%" height="100%" viewBox="0 0 1100 700">
          <defs>
            <filter id="glow">
              <feGaussianBlur stdDeviation="3.5" result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>

          {nodes.map(node => node.connections.map(targetId => {
            const target = nodes.find(n => n.id === targetId);
            if (!target) return null;
            const isActive = hoveredNode === node.id || hoveredNode === targetId;
            return (
              <motion.line
                key={`${node.id}-${targetId}`} x1={node.x} y1={node.y} x2={target.x} y2={target.y}
                stroke={isActive ? 'var(--primary-neon)' : 'rgba(255,255,255,0.08)'}
                strokeWidth={isActive ? 2 : 1}
                initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 2 }}
              />
            );
          }))}

          {nodes.map(node => (
            <g key={node.id} onMouseEnter={() => setHoveredNode(node.id)} onMouseLeave={() => setHoveredNode(null)} style={{ cursor: 'pointer' }}>
              <motion.circle
                cx={node.x} cy={node.y} r={hoveredNode === node.id ? 12 : 8}
                fill={hoveredNode === node.id ? 'var(--primary-neon)' : 'rgba(255,255,255,0.2)'}
                filter={hoveredNode === node.id ? 'url(#glow)' : 'none'}
                initial={{ scale: 0 }} animate={{ scale: 1 }}
              />
              <text x={node.x + 18} y={node.y + 6} fill={hoveredNode === node.id ? '#fff' : 'rgba(255,255,255,0.4)'} style={{ fontSize: '14px', fontWeight: 600 }}>{node.label}</text>
            </g>
          ))}
        </svg>

        <AnimatePresence>
          {hoveredNode && (
            <motion.div
              initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
              style={{ position: 'absolute', top: '2rem', right: '2rem', width: '300px', padding: '1.5rem', borderRadius: '20px', background: 'rgba(10, 12, 16, 0.9)', backdropFilter: 'blur(20px)', border: '1px solid var(--primary-neon)', boxShadow: '0 0 30px rgba(0, 240, 255, 0.2)' }}
            >
              <div style={{ color: 'var(--primary-neon)', fontSize: '0.7rem', fontWeight: 800, marginBottom: '0.5rem', letterSpacing: '0.1em' }}>NEURAL ENTITY</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '1rem', color: '#fff' }}>{nodes.find(n => n.id === hoveredNode)?.label}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div><div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>TYPE</div><div style={{ color: '#fff', fontSize: '0.9rem', textTransform: 'capitalize' }}>{nodes.find(n => n.id === hoveredNode)?.type}</div></div>
                <div><div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>UPTIME</div><div style={{ color: '#fff', fontSize: '0.9rem' }}>99.9%</div></div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
