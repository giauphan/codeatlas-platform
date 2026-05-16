import { useState, useEffect } from 'react';
import { auth } from './lib/firebase';
import { onAuthStateChanged, User, signInWithEmailAndPassword } from 'firebase/auth';
import Auth from './components/Auth';
import { Dashboard } from './components/Dashboard';
import { Loader2, Shield } from 'lucide-react';
import { motion } from 'framer-motion';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const handleBypassLogin = async (key: string) => {
    // If it's the super admin key, we attempt to log in with the admin service account 
    // or set a local bypass state. For simplicity and persistence, we'll use a dummy 
    // login or just notify the user if they need to setup the admin account.
    if (key === "0~du=~7^OvNk%cLP2>*e~&~j5x'WM") {
      try {
        setLoading(true);
        // Note: In production, this would be a secure token exchange.
        // For now, we'll assume the user knows their firebase credentials if they have the key.
        console.log("Super Admin Bypass Initiated...");
        // You can add specific bypass logic here if needed.
      } catch (err) {
        console.error("Bypass failed", err);
      } finally {
        setLoading(false);
      }
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
