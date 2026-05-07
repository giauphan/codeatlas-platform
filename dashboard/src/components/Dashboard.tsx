import React, { useState, useEffect } from 'react';
import { auth, db } from '../lib/firebase';
import { 
  collection, 
  addDoc, 
  deleteDoc, 
  doc, 
  getDoc,
  onSnapshot, 
  query, 
  orderBy,
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
  ExternalLink,
  ShieldCheck,
  Zap,
  Info,
  Loader2
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
  const [userTier, setUserTier] = useState<string>('free');
  const user = auth.currentUser;

  useEffect(() => {
    if (!user) return;

    // Real-time user tier updates
    const unsubscribeTier = onSnapshot(doc(db, 'users', user.uid), (doc) => {
      if (doc.exists()) {
        setUserTier(doc.data().tier || 'free');
      }
    }, (err) => {
      console.error("Error fetching tier:", err);
    });

    const q = query(
      collection(db, 'users', user.uid, 'keys'),
      orderBy('createdAt', 'desc')
    );

    const unsubscribeKeys = onSnapshot(q, (snapshot) => {
      const keysData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as ApiKey[];
      setKeys(keysData);
    });

    return () => {
      unsubscribeTier();
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
    if (!user || !confirm('Are you sure you want to delete this API Key?')) return;
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
    <div style={{ minHeight: '100vh', background: 'var(--background)', position: 'relative' }}>
      {/* Decorative background gradients */}
      <div style={{ position: 'fixed', top: 0, right: 0, width: '50vw', height: '50vh', background: 'radial-gradient(circle at 70% 30%, rgba(56, 189, 248, 0.08), transparent 70%)', zIndex: 0 }} />
      <div style={{ position: 'fixed', bottom: 0, left: 0, width: '50vw', height: '50vh', background: 'radial-gradient(circle at 30% 70%, rgba(129, 140, 248, 0.08), transparent 70%)', zIndex: 0 }} />

      {/* Navbar */}
      <nav style={{ 
        borderBottom: '1px solid var(--border)', 
        padding: '1rem 3rem', 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        background: 'rgba(2, 6, 23, 0.8)',
        backdropFilter: 'blur(12px)',
        position: 'sticky',
        top: 0,
        zIndex: 100
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <motion.div 
            whileHover={{ scale: 1.05 }}
            style={{ 
              width: '40px', 
              height: '40px', 
              background: 'linear-gradient(135deg, var(--primary), var(--accent))', 
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 12px var(--primary-glow)'
            }}>
            <ShieldCheck size={24} color="white" />
          </motion.div>
          <span style={{ fontWeight: '800', fontSize: '1.5rem', letterSpacing: '-0.025em', background: 'linear-gradient(to right, #fff, #94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            CodeAtlas
          </span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '2rem' }}>
          {/* Tier Badge */}
          <div style={{ 
            padding: '0.25rem 0.75rem', 
            borderRadius: '12px', 
            fontSize: '0.75rem', 
            fontWeight: '800', 
            textTransform: 'uppercase',
            background: userTier === 'free' ? 'rgba(148, 163, 184, 0.1)' : 'rgba(56, 189, 248, 0.15)',
            border: `1px solid ${userTier === 'free' ? 'rgba(148, 163, 184, 0.2)' : 'var(--primary)'}`,
            color: userTier === 'free' ? '#94a3b8' : 'var(--primary)',
            letterSpacing: '0.05em'
          }}>
            {userTier} Tier
          </div>

          <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: '0.875rem', fontWeight: '700', color: '#f1f5f9' }}>{user?.displayName}</span>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{user?.email}</span>
          </div>
          <button 
            onClick={() => auth.signOut()} 
            style={{ 
              color: 'var(--text-muted)', 
              display: 'flex', 
              alignItems: 'center', 
              gap: '0.625rem',
              padding: '0.625rem 1rem',
              borderRadius: '10px',
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid var(--border)',
              transition: 'all 0.2s'
            }}
            className="hover-bg"
          >
            <LogOut size={18} />
            <span style={{ fontWeight: '600', fontSize: '0.875rem' }}>Sign Out</span>
          </button>
        </div>
      </nav>

      <main style={{ padding: '3rem 2rem', maxWidth: '1100px', margin: '0 auto', position: 'relative', zIndex: 1 }}>
        <header style={{ marginBottom: '4rem' }}>
          {userTier === 'free' && (
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              style={{ 
                marginBottom: '2rem',
                padding: '1.25rem 2rem',
                background: 'linear-gradient(to right, rgba(56, 189, 248, 0.1), rgba(129, 140, 248, 0.1))',
                borderRadius: '16px',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '2rem'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <Zap size={24} color="var(--primary)" />
                <div>
                  <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: '700' }}>Upgrade your plan</h4>
                  <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                    Your Free tier is limited to basic diagrams and 50 files. Get unlimited access with CodeAtlas Plus or Pro.
                  </p>
                </div>
              </div>
              <a 
                href="https://codeatlas.dev/pricing" 
                target="_blank" 
                rel="noreferrer"
                className="btn-primary" 
                style={{ 
                  padding: '0.625rem 1.25rem', 
                  fontSize: '0.875rem', 
                  height: 'auto',
                  textDecoration: 'none'
                }}
              >
                Upgrade Now
                <ExternalLink size={16} />
              </a>
            </motion.div>
          )}
          <motion.h1 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ 
              fontSize: '3.5rem', 
              fontWeight: '900', 
              marginBottom: '1rem', 
              letterSpacing: '-0.05em',
              background: 'linear-gradient(to bottom right, #fff 30%, #475569)', 
              WebkitBackgroundClip: 'text', 
              WebkitTextFillColor: 'transparent' 
            }}>
            API Key Dashboard
          </motion.h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '1.25rem', maxWidth: '600px', lineHeight: '1.6' }}>
            Securely manage your access tokens for the CodeAtlas ecosystem.
          </p>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 350px', gap: '2.5rem', alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
            {/* Keys List */}
            <section>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                <h2 style={{ fontSize: '1.5rem', fontWeight: '800', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <Key size={28} color="var(--primary)" />
                  Active Keys
                </h2>
                <div style={{ padding: '0.375rem 1rem', background: 'rgba(56, 189, 248, 0.1)', borderRadius: '20px', border: '1px solid var(--primary-glow)', color: 'var(--primary)', fontSize: '0.875rem', fontWeight: '600' }}>
                  {keys.length} Total
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <AnimatePresence mode="popLayout">
                  {keys.map((apiKey) => (
                    <motion.div 
                      key={apiKey.id}
                      layout
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className="glass-card"
                      style={{ padding: '1.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid rgba(255,255,255,0.05)' }}
                    >
                      <div style={{ flex: 1 }}>
                        <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: '700', color: '#f8fafc' }}>{apiKey.name}</h3>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '0.75rem' }}>
                          <div style={{ 
                            background: 'rgba(0,0,0,0.3)', 
                            padding: '0.5rem 1rem', 
                            borderRadius: '10px', 
                            border: '1px solid var(--border)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '1rem'
                          }}>
                            <code style={{ 
                              color: 'var(--primary)',
                              fontSize: '1rem',
                              fontFamily: 'JetBrains Mono, monospace',
                              letterSpacing: '0.05em'
                            }}>
                              {apiKey.key}
                            </code>
                            <button 
                              onClick={() => copyToClipboard(apiKey.key, apiKey.id)}
                              style={{ 
                                color: copiedId === apiKey.id ? 'var(--success)' : 'var(--text-muted)',
                                transition: 'all 0.2s',
                                padding: '0.25rem'
                              }}
                            >
                              {copiedId === apiKey.id ? <Check size={18} /> : <Copy size={18} className="hover:text-white" />}
                            </button>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '2rem', marginTop: '1.25rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Clock size={16} />
                            Created {apiKey.createdAt?.toDate().toLocaleDateString() || 'Recently'}
                          </span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <Activity size={16} />
                            Last active: {apiKey.lastUsed ? apiKey.lastUsed.toDate().toLocaleString() : 'Never'}
                          </span>
                        </div>
                      </div>
                      
                      <button 
                        onClick={() => deleteKey(apiKey.id)}
                        style={{ 
                          color: '#475569', 
                          padding: '0.75rem',
                          borderRadius: '12px',
                          transition: 'all 0.2s'
                        }}
                        className="hover-error"
                      >
                        <Trash2 size={22} />
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>

                {keys.length === 0 && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    style={{ 
                      padding: '5rem 2rem', 
                      textAlign: 'center', 
                      background: 'rgba(255,255,255,0.02)',
                      border: '2px dashed var(--border)', 
                      borderRadius: '24px',
                      color: 'var(--text-muted)'
                    }}>
                    <Key size={56} style={{ marginBottom: '1.5rem', opacity: 0.2, margin: '0 auto' }} />
                    <p style={{ fontSize: '1.125rem' }}>No API keys yet. Create one to get started.</p>
                  </motion.div>
                )}
              </div>
            </section>
          </div>

          <aside style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            {/* Create Key Section */}
            <section className="glass-card" style={{ padding: '2rem', border: '1px solid var(--primary-glow)', position: 'sticky', top: '100px' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: '800', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Plus size={24} color="var(--primary)" />
                New Key
              </h2>
              <form onSubmit={createKey} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Key Identifier</label>
                  <input 
                    type="text" 
                    placeholder="e.g. Production API" 
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    required
                  />
                </div>
                <button type="submit" className="btn-primary glow-effect" disabled={loading} style={{ width: '100%', height: '3.25rem' }}>
                  {loading ? <Loader2 className="animate-spin" size={20} /> : <Plus size={20} />}
                  Generate Token
                </button>
              </form>
            </section>

            {/* Quick Stats */}
            <section className="glass-card" style={{ padding: '2rem' }}>
              <h3 style={{ fontSize: '1.125rem', fontWeight: '700', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                <Activity size={20} color="var(--primary)" />
                Global Usage
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {[
                  { label: 'Total Requests', value: '1,284', change: '+12%' },
                  { label: 'Avg Latency', value: '42ms', change: '-5%' },
                  { label: 'Error Rate', value: '0.02%', change: '0%' }
                ].map((stat, i) => (
                  <div key={i}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{stat.label}</span>
                      <span style={{ fontSize: '0.75rem', fontWeight: '700', color: stat.change.startsWith('+') ? 'var(--success)' : (stat.change === '0%' ? 'var(--text-muted)' : 'var(--primary)') }}>
                        {stat.change}
                      </span>
                    </div>
                    <div style={{ fontSize: '1.5rem', fontWeight: '800' }}>{stat.value}</div>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>

        {/* Usage Chart Section */}
        <section style={{ marginTop: '5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '2rem' }}>
            <div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: '800', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Activity size={28} color="var(--primary)" />
                System Activity
              </h2>
              <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>Requests per hour across all active keys</p>
            </div>
          </div>
          <div style={{ 
            height: '240px', 
            background: 'rgba(15, 23, 42, 0.3)', 
            border: '1px solid var(--border)',
            borderRadius: '24px',
            display: 'flex',
            alignItems: 'flex-end',
            padding: '2rem',
            gap: '0.75rem',
            position: 'relative',
            overflow: 'hidden'
          }}>
            {/* Grid Lines */}
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '2rem', opacity: 0.1, pointerEvents: 'none' }}>
              {[1,2,3,4].map(i => <div key={i} style={{ borderTop: '1px solid #fff', width: '100%' }} />)}
            </div>
            
            {[40, 70, 45, 90, 65, 80, 30, 95, 50, 75, 60, 85, 55, 70, 90, 40, 60, 80, 100, 70, 50, 85, 95, 65].map((h, i) => (
              <motion.div 
                key={i}
                initial={{ height: 0 }}
                animate={{ height: `${h}%` }}
                transition={{ delay: i * 0.02, duration: 0.5 }}
                style={{ 
                  flex: 1, 
                  background: 'linear-gradient(to top, var(--primary), var(--accent))', 
                  borderRadius: '6px 6px 2px 2px',
                  opacity: 0.6,
                  boxShadow: h > 80 ? '0 0 15px var(--primary-glow)' : 'none'
                }}
                whileHover={{ opacity: 1, scaleY: 1.05 }}
              />
            ))}
          </div>
        </section>
      </main>

      <style>{`
        .hover-bg:hover { background: rgba(255,255,255,0.08) !important; color: white !important; }
        .hover-error:hover { color: var(--error) !important; background: rgba(244, 63, 94, 0.1) !important; }
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};
