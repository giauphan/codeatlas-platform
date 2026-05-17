import React, { useState } from 'react';
import { auth } from '../lib/firebase';
import { 
  signInWithEmailAndPassword, 
  sendPasswordResetEmail 
} from 'firebase/auth';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Shield, 
  Key, 
  Mail, 
  Lock, 
  LogIn, 
  Globe,
  Loader2,
  ChevronRight,
  Info
} from 'lucide-react';

interface AuthProps {
  onLogin: (key: string) => void;
}

const Auth: React.FC<AuthProps> = ({ onLogin }) => {
  const [mode, setMode] = useState<'token' | 'signin'>('token');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTokenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await onLogin(apiKey.trim());
    } catch (err: any) {
      setError(err.message || 'Invalid API Key or Token');
    } finally {
      setLoading(false);
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      setError(err.message.replace('Firebase: ', ''));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      height: '100vh', width: '100vw', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--background)', position: 'relative', overflow: 'hidden', color: '#fff'
    }}>
      {/* Dynamic Background */}
      <div style={{ position: 'absolute', top: '10%', left: '10%', width: '500px', height: '500px', background: 'rgba(0, 240, 255, 0.05)', filter: 'blur(120px)', borderRadius: '50%' }} />
      <div style={{ position: 'absolute', bottom: '10%', right: '10%', width: '500px', height: '500px', background: 'rgba(157, 0, 255, 0.05)', filter: 'blur(120px)', borderRadius: '50%' }} />

      <div className="glass-panel" style={{ width: '460px', padding: '3.5rem', borderRadius: '32px', zIndex: 10, border: '1px solid rgba(255,255,255,0.05)', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)' }}>
        <header style={{ textAlign: 'center', marginBottom: '3rem' }}>
          <h1 className="tech-font" style={{ fontSize: '2rem', letterSpacing: '0.15em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', margin: '0 0 0.5rem 0' }}>
            CODEATLAS <Shield style={{ color: 'var(--primary-neon)' }} size={28} />
          </h1>
          <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', letterSpacing: '0.3em', margin: 0, fontWeight: 800 }}>NEURAL REASONING MATRIX</p>
        </header>

        {/* Tab Switcher */}
        <div style={{ display: 'flex', background: 'rgba(0,0,0,0.3)', padding: '0.4rem', borderRadius: '16px', marginBottom: '2.5rem', border: '1px solid rgba(255,255,255,0.05)' }}>
          {[
            { id: 'token', label: 'TOKEN', icon: Key },
            { id: 'signin', label: 'SIGN IN', icon: LogIn },
          ].map((tab) => (
            <button
              key={tab.id}
              disabled={loading}
              onClick={() => { setMode(tab.id as any); setError(null); }}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0.75rem', borderRadius: '12px', border: 'none', cursor: loading ? 'not-allowed' : 'pointer', fontSize: '0.75rem', fontWeight: 800, transition: 'all 0.3s',
                background: mode === tab.id ? 'rgba(255,255,255,0.1)' : 'transparent',
                color: mode === tab.id ? '#fff' : 'var(--text-muted)',
                opacity: loading ? 0.5 : 1
              }}
            >
              <tab.icon size={14} /> {tab.label}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {mode === 'token' ? (
            <motion.form key="token" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} onSubmit={handleTokenSubmit}>
              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem', fontWeight: 700 }}>NEURAL ACCESS KEY</label>
                <div style={{ position: 'relative' }}>
                  <Key size={18} style={{ position: 'absolute', left: '1rem', top: '1rem', color: 'var(--primary-neon)' }} />
                  <input type="password" style={{ paddingLeft: '3rem' }} className="glass-input" placeholder="Enter your Enterprise Key..." value={apiKey} onChange={e => setApiKey(e.target.value)} disabled={loading} required autoFocus />
                </div>
              </div>
              {error && <div style={{ background: 'rgba(255, 75, 75, 0.1)', border: '1px solid #ff4b4b', color: '#ff4b4b', padding: '1rem', borderRadius: '12px', fontSize: '0.8rem', marginBottom: '1.5rem', fontWeight: 600 }}>{error}</div>}
              <button type="submit" className="btn-neon-cyan" style={{ width: '100%', height: '54px', fontWeight: 800 }} disabled={loading}>
                {loading ? <Loader2 className="animate-spin" size={24} /> : 'INITIALIZE SESSION'}
              </button>
            </motion.form>
          ) : (
            <motion.form key="auth" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} onSubmit={handleAuthSubmit}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginBottom: '2rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem', fontWeight: 700 }}>EMAIL ADDRESS</label>
                  <div style={{ position: 'relative' }}>
                     <Mail size={18} style={{ position: 'absolute', left: '1rem', top: '1rem', color: 'var(--primary-neon)' }} />
                    <input type="email" style={{ paddingLeft: '3rem' }} className="glass-input" placeholder="name@genrostore.com" value={email} onChange={e => setEmail(e.target.value)} required />
                  </div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem', fontWeight: 700 }}>PASSWORD</label>
                  <div style={{ position: 'relative' }}>
                    <Lock size={18} style={{ position: 'absolute', left: '1rem', top: '1rem', color: 'var(--primary-neon)' }} />
                    <input type="password" style={{ paddingLeft: '3rem' }} className="glass-input" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required />
                  </div>
                </div>
              </div>
              {error && <div style={{ background: 'rgba(255, 75, 75, 0.1)', border: '1px solid #ff4b4b', color: '#ff4b4b', padding: '1rem', borderRadius: '12px', fontSize: '0.8rem', marginBottom: '1.5rem', fontWeight: 600 }}>{error}</div>}
              <button type="submit" className="btn-neon-cyan" style={{ width: '100%', height: '54px', fontWeight: 800 }} disabled={loading}>
                {loading ? <Loader2 className="animate-spin" size={24} /> : 'ENTER SYSTEM'}
              </button>
            </motion.form>
          )}
        </AnimatePresence>

        {/* Secure connection disclaimer */}
        <div style={{ display: 'flex', alignItems: 'center', margin: '2.5rem 0', color: 'rgba(255,255,255,0.1)' }}>
          <div style={{ flex: 1, height: '1px', background: 'currentColor' }} />
          <span style={{ padding: '0 1rem', fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 800 }}>SECURE CONNECTION</span>
          <div style={{ flex: 1, height: '1px', background: 'currentColor' }} />
        </div>

        <footer style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: 'rgba(255,255,255,0.2)', fontFamily: 'monospace' }}>
          SECURE LINK // AES-256-GCM // NODE-ID: {Math.random().toString(16).slice(2, 10).toUpperCase()}
        </footer>
      </div>

      {/* Side Decorations */}
      <div style={{ position: 'absolute', bottom: '2rem', left: '2rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700 }}>
        <Globe size={14} /> CLOUD SYNC: ACTIVE
      </div>
      <div style={{ position: 'absolute', bottom: '2rem', right: '2rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700 }}>
        ORACLE 26ai LINK: ESTABLISHED <div style={{ width: '6px', height: '6px', background: '#00FF94', borderRadius: '50%', boxShadow: '0 0 8px #00FF94' }} />
      </div>

      <style>{`
        .glass-panel { background: rgba(13, 17, 23, 0.8); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
        .glass-input { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 0.875rem 1rem; border-radius: 14px; width: 100%; transition: all 0.3s; font-size: 0.95rem; }
        .glass-input:focus { outline: none; border-color: var(--primary-neon); box-shadow: 0 0 20px rgba(0, 240, 255, 0.15); }
        .tech-font { font-family: 'Inter', system-ui, sans-serif; }
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

export default Auth;
