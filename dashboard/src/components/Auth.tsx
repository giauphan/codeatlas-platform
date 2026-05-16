import React, { useState } from 'react';
import { auth, db } from '../lib/firebase';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword,
  updateProfile
} from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { motion, AnimatePresence } from 'framer-motion';
import { LogIn, UserPlus, Github, Loader2 } from 'lucide-react';

export const Auth: React.FC = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(userCredential.user, { displayName });
        
        // Initialize user tier in Firestore
        await setDoc(doc(db, 'users', userCredential.user.uid), {
          displayName,
          email,
          tier: 'enterprise',
          createdAt: new Date().toISOString()
        });
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ 
      minHeight: '100vh', 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center',
      background: 'radial-gradient(circle at top right, rgba(56, 189, 248, 0.1), transparent), radial-gradient(circle at bottom left, rgba(129, 140, 248, 0.1), transparent)',
      padding: '1.5rem',
      position: 'relative',
      overflow: 'hidden'
    }}>
      {/* Decorative background elements */}
      <div style={{ position: 'absolute', top: '-10%', right: '-10%', width: '40%', height: '40%', background: 'var(--primary-glow)', filter: 'blur(120px)', borderRadius: '50%', zIndex: 0 }} />
      <div style={{ position: 'absolute', bottom: '-10%', left: '-10%', width: '40%', height: '40%', background: 'rgba(129, 140, 248, 0.15)', filter: 'blur(120px)', borderRadius: '50%', zIndex: 0 }} />

      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="glass-card"
        style={{ 
          width: '100%', 
          maxWidth: '440px', 
          padding: '3rem',
          position: 'relative',
          zIndex: 1,
          border: '1px solid rgba(255, 255, 255, 0.08)'
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
          <motion.div 
            initial={{ rotate: -10, scale: 0.9 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 200 }}
            style={{ 
              width: '80px', 
              height: '80px', 
              background: 'linear-gradient(135deg, var(--primary), var(--accent))', 
              borderRadius: '20px', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              margin: '0 auto 1.5rem',
              boxShadow: '0 8px 32px var(--primary-glow)',
              position: 'relative'
            }}
          >
            <Github size={40} color="white" />
            <div style={{ position: 'absolute', inset: '-2px', border: '2px solid var(--primary)', borderRadius: '22px', opacity: 0.5 }} />
          </motion.div>
          <h1 style={{ 
            fontSize: '2rem', 
            fontWeight: '800', 
            marginBottom: '0.75rem', 
            letterSpacing: '-0.025em',
            background: 'linear-gradient(to bottom, #fff, #94a3b8)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent'
          }}>
            {isLogin ? 'Welcome Back' : 'Create Account'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '1rem' }}>
            Enter your details to access CodeAtlas
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {!isLogin && (
            <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}>
              <label style={{ display: 'block', marginBottom: '0.625rem', fontSize: '0.875rem', fontWeight: '500', color: '#cbd5e1' }}>Full Name</label>
              <input 
                type="text" 
                placeholder="John Doe" 
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </motion.div>
          )}
          <div>
            <label style={{ display: 'block', marginBottom: '0.625rem', fontSize: '0.875rem', fontWeight: '500', color: '#cbd5e1' }}>Email Address</label>
            <input 
              type="email" 
              placeholder="name@company.com" 
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '0.625rem', fontSize: '0.875rem', fontWeight: '500', color: '#cbd5e1' }}>Password</label>
            <input 
              type="password" 
              placeholder="••••••••" 
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <AnimatePresence>
            {error && (
              <motion.div 
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                style={{ 
                  color: 'var(--error)', 
                  fontSize: '0.875rem', 
                  textAlign: 'center',
                  background: 'rgba(244, 63, 94, 0.1)',
                  padding: '0.75rem',
                  borderRadius: '10px',
                  border: '1px solid rgba(244, 63, 94, 0.2)'
                }}
              >
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          <button 
            type="submit" 
            className="btn-primary glow-effect" 
            disabled={loading}
            style={{ marginTop: '0.5rem', width: '100%', height: '3.25rem' }}
          >
            {loading ? <Loader2 className="animate-spin" size={22} /> : (isLogin ? <LogIn size={22} /> : <UserPlus size={22} />)}
            <span style={{ fontSize: '1rem' }}>{isLogin ? 'Sign In' : 'Create Account'}</span>
          </button>
        </form>

        <div style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.925rem' }}>
          <span style={{ color: 'var(--text-muted)' }}>
            {isLogin ? "Don't have an account? " : "Already have an account? "}
          </span>
          <button 
            onClick={() => setIsLogin(!isLogin)}
            style={{ 
              color: 'var(--primary)', 
              fontWeight: '600',
              textDecoration: 'underline',
              textUnderlineOffset: '4px'
            }}
          >
            {isLogin ? 'Sign Up' : 'Sign In'}
          </button>
        </div>
      </motion.div>
    </div>
  );
};
