import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  Database,
  Globe,
  Copy,
  Check,
  Trash2,
  RefreshCw
} from 'lucide-react';

interface ControlCenterProps {
  stats: { totalRequests: number };
  keys: any[];
  analysis: any;
  createKey: (e: React.FormEvent) => Promise<void>;
  deleteKey: (id: string) => Promise<void>;
  copyToClipboard: (text: string, id: string) => void;
  copiedId: string | null;
  newKeyName: string;
  setNewKeyName: (name: string) => void;
  loading: boolean;
  createdKey?: string | null;
  clearCreatedKey?: () => void;
}

export const ControlCenterView: React.FC<ControlCenterProps> = ({
  stats,
  keys,
  analysis,
  createKey,
  deleteKey,
  copyToClipboard,
  copiedId,
  newKeyName,
  setNewKeyName,
  loading,
  createdKey,
  clearCreatedKey
}) => {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopyNewToken = () => {
    if (!createdKey) return;
    copyToClipboard(createdKey, 'new_key');
    if (clearCreatedKey) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(clearCreatedKey, 5000);
    }
  };

  return (
    <>
      <header style={{ marginBottom: '3.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ fontSize: '3.5rem', margin: 0, fontWeight: 900 }} className="tech-font">Neural Control</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '1.1rem', marginTop: '0.5rem' }}>Orchestrating codebase intelligence and secure access.</p>
        </div>
        <div style={{ padding: '0.65rem 1.25rem', borderRadius: '10px', background: 'rgba(0, 240, 255, 0.1)', border: '1px solid var(--primary-neon)', color: 'var(--primary-neon)', fontWeight: 800, fontSize: '0.9rem' }}>
          v2.2.1 ONLINE
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
                  <code style={{ color: 'var(--primary-neon)', fontSize: '0.95rem', background: 'rgba(0,0,0,0.2)', padding: '0.4rem 0.75rem', borderRadius: '6px' }}>{k.keyPreview || k.key}</code>
                </div>
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  {k.key && (
                    <button aria-label={`Copy token: ${k.name ?? 'unnamed'}`} title={`Copy token: ${k.name ?? 'unnamed'}`} onClick={() => copyToClipboard(k.key, k.id)} style={{ background: 'rgba(255,255,255,0.05)', border: 'none', padding: '0.75rem', borderRadius: '12px', cursor: 'pointer', color: copiedId === k.id ? 'var(--primary-neon)' : '#fff' }}>
                      {copiedId === k.id ? <Check size={20} /> : <Copy size={20} />}
                    </button>
                  )}
                  <button aria-label={`Delete token: ${k.name ?? 'unnamed'}`} title={`Delete token: ${k.name ?? 'unnamed'}`} onClick={() => deleteKey(k.id)} style={{ background: 'rgba(255, 75, 75, 0.05)', border: 'none', padding: '0.75rem', borderRadius: '12px', cursor: 'pointer', color: '#ff4b4b' }}><Trash2 size={20} /></button>
                </div>
              </motion.div>
            ))}
          </div>
        </section>
        <aside style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          {createdKey && (
            <div className="glass-panel" style={{ padding: '2rem', borderRadius: '32px', border: '1px solid #00FF94', alignSelf: 'start', background: 'rgba(0, 255, 148, 0.05)' }}>
              <h3 className="tech-font" style={{ fontSize: '1.25rem', marginBottom: '1rem', fontWeight: 800, color: '#00FF94' }}>TOKEN GENERATED</h3>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1.5rem', lineHeight: '1.5' }}>
                Please copy this key immediately. For security reasons, <strong>it will never be shown again</strong>.
              </p>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <code style={{ flex: 1, color: '#fff', fontSize: '0.95rem', background: 'rgba(0,0,0,0.4)', padding: '1rem', borderRadius: '12px', border: '1px solid rgba(0,255,148,0.2)', wordBreak: 'break-all' }}>{createdKey}</code>
                <button
                  aria-label="Copy new token"
                  title="Copy new token"
                  onClick={handleCopyNewToken}
                  style={{ background: '#00FF94', border: 'none', padding: '1rem', borderRadius: '12px', cursor: 'pointer', color: '#000' }}
                >
                  {copiedId === 'new_key' ? <Check size={20} /> : <Copy size={20} />}
                </button>
              </div>
            </div>
          )}

          <div className="glass-panel" style={{ padding: '2rem', borderRadius: '32px', border: '1px solid rgba(255,255,255,0.05)', alignSelf: 'start' }}>
            <h3 className="tech-font" style={{ fontSize: '1.25rem', marginBottom: '1.5rem', fontWeight: 800 }}>GENERATE TOKEN</h3>
            <form onSubmit={createKey} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <input type="text" className="glass-input" placeholder="Identifier (e.g. CI/CD Pipeline)" value={newKeyName} onChange={e => setNewKeyName(e.target.value)} required />
              <button type="submit" className="btn-neon-cyan" style={{ width: '100%', height: '54px', fontSize: '1rem', fontWeight: 800 }} disabled={loading}>
                {loading ? <RefreshCw className="animate-spin" size={20} /> : 'CREATE ACCESS TOKEN'}
              </button>
            </form>
          </div>
        </aside>
      </div>
    </>
  );
};
