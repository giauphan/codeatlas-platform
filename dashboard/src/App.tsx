import { useState, useEffect } from 'react';
import { auth } from './lib/firebase';
import { onAuthStateChanged, User, signInWithEmailAndPassword } from 'firebase/auth';
import Auth from './components/Auth';
import { Dashboard } from './components/Dashboard';
import { Loader2, Shield } from 'lucide-react';
import { motion } from 'framer-motion';

function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check for an active API Key session in secure session storage
    const savedApiKey = sessionStorage.getItem('ca_api_key');
    if (savedApiKey) {
      setUser({ uid: 'api-key-session', email: 'api-key-user@codeatlas.local', isApiKeySession: true });
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const handleBypassLogin = async (key: string) => {
    if (!key.trim()) return;

    const API_BASE = window.location.origin.includes('localhost:5173') 
      ? 'http://localhost:8080' 
      : window.location.origin;

    try {
      const resp = await fetch(`${API_BASE}/api/projects`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key.trim()
        }
      });

      if (!resp.ok) {
        let errMsg = 'Invalid API Key or Token';
        try {
          const errData = await resp.json();
          if (errData && errData.error) errMsg = errData.error;
        } catch {}
        throw new Error(errMsg);
      }

      sessionStorage.setItem('ca_api_key', key.trim());
      setUser({ uid: 'api-key-session', email: 'api-key-user@codeatlas.local', isApiKeySession: true });
    } catch (err: any) {
      console.error("Token validation failed:", err);
      throw err;
    }
  };

  if (loading) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        display: 'flex', 
        flexDirection: 'column',
        alignItems: 'center', 
        justifyContent: 'center',
        background: 'var(--background)',
        color: 'var(--primary-neon)'
      }}>
        <motion.div
          animate={{ 
            scale: [1, 1.1, 1],
            rotate: [0, 90, 180, 270, 360],
            opacity: [0.5, 1, 0.5]
          }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
          style={{ marginBottom: '2rem' }}
        >
          <Shield size={64} />
        </motion.div>
        <div className="tech-font" style={{ fontSize: '1.2rem', letterSpacing: '0.2em' }}>
          INITIALIZING NEURAL LINK...
        </div>
        <div style={{ marginTop: '1rem', width: '200px', height: '2px', background: 'rgba(255,255,255,0.1)', position: 'relative', overflow: 'hidden' }}>
          <motion.div 
            animate={{ left: ['-100%', '100%'] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
            style={{ position: 'absolute', top: 0, width: '50%', height: '100%', background: 'var(--primary-neon)', boxShadow: '0 0 10px var(--primary-neon)' }} 
          />
        </div>
      </div>
    );
  }

  return (
    <>
      {user ? <Dashboard /> : <Auth onLogin={handleBypassLogin} />}
    </>
  );
}

export default App;
