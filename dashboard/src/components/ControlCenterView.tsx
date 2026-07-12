import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  Database,
  Globe,
  Copy,
  Check,
  Trash2,
  RefreshCw,
  Clock,
  Save
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
  clearCreatedKey,
}) => {
  const [cronSchedule, setCronSchedule] = useState('0 19 * * *');
  const [cronEnabled, setCronEnabled] = useState(true);
  const [cronSaving, setCronSaving] = useState(false);
  const [cronSaved, setCronSaved] = useState(false);
  const [cronError, setCronError] = useState('');

  // Fetch current cron schedule on mount
  useEffect(() => {
    fetch('/api/settings/cron')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.dreams_schedule) {
          setCronSchedule(data.dreams_schedule);
          setCronEnabled(data.dreams_enabled !== false);
        }
      })
      .catch(() => {});
  }, []);

  const saveCron = async () => {
    setCronSaving(true);
    setCronError('');
    setCronSaved(false);
    try {
      const resp = await fetch('/api/settings/cron', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dreams_schedule: cronSchedule, dreams_enabled: cronEnabled }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Failed to save');
      }
      setCronSaved(true);
      setTimeout(() => setCronSaved(false), 3000);
    } catch (err: any) {
      setCronError(err.message);
    } finally {
      setCronSaving(false);
    }
  };

const freqLabels: Record<string, string> = {
  '0 19 * * *': 'Daily 19:00',
  '0 */6 * * *': 'Every 6 hours',
  '0 */4 * * *': 'Every 4 hours',
  '0 */2 * * *': 'Every 2 hours',
  '0 0 * * *': 'Daily midnight',
  '0 9 * * *': 'Daily 09:00',
  '30 9 * * *': 'Daily 09:30',
};

  return (
    <>
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <header style={{ marginBottom: '2.5rem' }}>
          <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0, fontWeight: 800 }}>
            <Activity size={32} style={{ marginRight: '0.75rem', verticalAlign: 'middle', color: 'var(--primary-neon)' }} />
            Control Center
          </h1>
          <p style={{ color: 'var(--text-muted)' }}>API keys, database activity, and background job scheduling.</p>
        </header>
      </motion.div>

      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1', minWidth: '300px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.1 } }}>
            <div className="glass-panel" style={{ padding: '2rem', borderRadius: '32px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <h3 className="tech-font" style={{ fontSize: '1.25rem', fontWeight: 800 }}>
                <Database size={20} style={{ marginRight: '0.5rem', verticalAlign: 'middle' }} />
                ACTIVITY
              </h3>
              <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: '2rem', fontWeight: 800, color: 'var(--primary-neon)' }}>{stats.totalRequests.toLocaleString()}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>TOTAL REQUESTS</div>
                </div>
              </div>
            </div>
          </motion.div>

          {keys.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.2 } }}>
              <div className="glass-panel" style={{ padding: '2rem', borderRadius: '32px' }}>
                <h3 className="tech-font" style={{ fontSize: '1.25rem', marginBottom: '1.5rem', fontWeight: 800 }}>ACTIVE TOKENS</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {keys.map((key: any) => (
                    <div key={key.id} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '1rem 1.25rem', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)',
                      background: 'rgba(255,255,255,0.03)'
                    }}>
                      <div>
                        <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>{key.name || key.id}</div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                          {key.key?.substring(0, 16)}...
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button onClick={() => copyToClipboard(key.key, key.id)} className="btn-ghost" style={{ padding: '0.5rem' }} aria-label="Copy token" title="Copy token">
                          {copiedId === key.id ? <Check size={16} color="#00F0FF" /> : <Copy size={16} />}
                        </button>
                        <button onClick={() => deleteKey(key.id)} className="btn-ghost" style={{ padding: '0.5rem', color: '#FF4B4B' }} aria-label="Delete token" title="Delete token">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </div>

        <aside style={{ width: '400px', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.3 } }}>
            <div className="glass-panel" style={{ padding: '2rem', borderRadius: '32px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <h3 className="tech-font" style={{ fontSize: '1.25rem', marginBottom: '0.5rem', fontWeight: 800 }}>
                <Clock size={20} style={{ marginRight: '0.5rem', verticalAlign: 'middle', color: 'var(--primary-neon)' }} />
                CRON SCHEDULE
              </h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
                Dream sync — auto-scans MCP server and syncs dreams to cloud.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem', display: 'block' }}>
                    Frequency
                  </label>
                  <select value={cronSchedule} onChange={e => setCronSchedule(e.target.value)}
                    className="glass-input" style={{ width: '100%', padding: '0.75rem 1rem', borderRadius: '12px' }}>
                    {Object.entries(freqLabels).map(([expr, label]) => (
                      <option key={expr} value={expr} style={{ background: '#111', color: '#fff' }}>{label} ({expr})</option>
                    ))}
                  </select>
                  <input type="text" value={cronSchedule} onChange={e => setCronSchedule(e.target.value)}
                    placeholder="Custom cron (e.g. 0 19 * * *)"
                    style={{ width: '100%', marginTop: '0.5rem', padding: '0.75rem 1rem', borderRadius: '12px',
                      border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)',
                      color: '#fff', fontSize: '0.85rem', fontFamily: 'monospace' }}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Enabled</label>
                  <button onClick={() => setCronEnabled(!cronEnabled)}
                    role="switch"
                    aria-checked={cronEnabled}
                    aria-label="Enable dream sync"
                    style={{
                      width: '44px', height: '24px', borderRadius: '12px', border: 'none', cursor: 'pointer',
                      background: cronEnabled ? 'var(--primary-neon)' : 'rgba(255,255,255,0.2)',
                      position: 'relative', transition: '0.2s'
                    }}>
                    <div style={{
                      width: '18px', height: '18px', borderRadius: '50%', background: '#fff',
                      position: 'absolute', top: '3px', transition: '0.2s',
                      left: cronEnabled ? '23px' : '3px'
                    }} />
                  </button>
                </div>

                <button onClick={saveCron} disabled={cronSaving}
                  style={{
                    width: '100%', padding: '0.85rem', borderRadius: '12px', border: '1px solid var(--primary-neon)',
                    background: 'rgba(0,240,255,0.1)', color: '#fff', fontWeight: 800, cursor: 'pointer', fontSize: '0.95rem'
                  }}>
                  {cronSaving ? <RefreshCw className="animate-spin" size={20} /> : (
                    <><Save size={18} style={{ marginRight: '0.5rem', verticalAlign: 'middle' }} />{cronSaved ? '✅ SAVED' : 'SAVE SCHEDULE'}</>
                  )}
                </button>
                {cronError && <div style={{ color: '#FF4B4B', fontSize: '0.85rem' }}>{cronError}</div>}
              </div>
            </div>
          </motion.div>

          {createdKey && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
              className="glass-panel" style={{ padding: '2rem', borderRadius: '32px', border: '1px solid #00FF0044' }}>
              <h3 className="tech-font" style={{ fontSize: '1.25rem', marginBottom: '1rem', fontWeight: 800, color: '#00FF00' }}>
                KEY CREATED
              </h3>
              <div style={{ fontFamily: 'monospace', fontSize: '0.85rem', wordBreak: 'break-all', padding: '1rem', borderRadius: '12px', background: 'rgba(0,255,0,0.05)', border: '1px solid rgba(0,255,0,0.2)', marginBottom: '1rem' }}>
                {createdKey}
              </div>
              <button onClick={clearCreatedKey} className="btn-neon-cyan" style={{ width: '100%' }}>DISMISS</button>
            </motion.div>
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
