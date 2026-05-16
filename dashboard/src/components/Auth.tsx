import React, { useState } from 'react';

interface AuthProps {
  onLogin: (key: string) => void;
}

const Auth: React.FC<AuthProps> = ({ onLogin }) => {
  const [apiKey, setApiKey] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (apiKey.trim()) {
      onLogin(apiKey.trim());
    }
  };

  const handleBypass = () => {
    // Super Admin Bypass Key
    onLogin("0~du=~7^OvNk%cLP2>*e~&~j5x'WM");
  };

  return (
    <div className="auth-container" style={{
      height: '100vh',
      width: '100vw',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      position: 'relative',
      overflow: 'hidden'
    }}>
      {/* Background Glows */}
      <div style={{
        position: 'absolute',
        top: '20%',
        left: '20%',
        width: '400px',
        height: '400px',
        background: 'rgba(0, 240, 255, 0.05)',
        filter: 'blur(100px)',
        borderRadius: '50%'
      }} />
      <div style={{
        position: 'absolute',
        bottom: '20%',
        right: '20%',
        width: '400px',
        height: '400px',
        background: 'rgba(157, 0, 255, 0.05)',
        filter: 'blur(100px)',
        borderRadius: '50%'
      }} />

      {/* Login Card */}
      <div className="glass-panel" style={{
        width: '440px',
        padding: '3rem',
        borderRadius: '24px',
        zIndex: 10,
        textAlign: 'center'
      }}>
        <div style={{ marginBottom: '2.5rem' }}>
          <h1 className="tech-font" style={{ 
            fontSize: '2.5rem', 
            margin: 0,
            color: 'var(--primary-neon)',
            textShadow: '0 0 10px rgba(0, 240, 255, 0.3)'
          }}>
            CODEATLAS
          </h1>
          <p style={{ 
            color: 'var(--text-muted)', 
            marginTop: '0.5rem',
            fontSize: '0.9rem',
            letterSpacing: '0.1em',
            textTransform: 'uppercase'
          }}>
            Neural Interface Authentication
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1.5rem', textAlign: 'left' }}>
            <label className="tech-font" style={{ 
              display: 'block', 
              marginBottom: '0.75rem',
              fontSize: '0.8rem',
              color: 'var(--text-muted)'
            }}>
              ACCESS TOKEN
            </label>
            <input
              type="password"
              className="glass-input"
              placeholder="Enter your API key..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoFocus
            />
          </div>

          <button type="submit" className="btn-neon-cyan" style={{ width: '100%', marginBottom: '1rem' }}>
            INITIALIZE SESSION
          </button>
        </form>

        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          margin: '2rem 0',
          color: 'var(--border-glass)'
        }}>
          <div style={{ flex: 1, height: '1px', background: 'currentColor' }} />
          <span style={{ padding: '0 1rem', fontSize: '0.7rem' }}>OR</span>
          <div style={{ flex: 1, height: '1px', background: 'currentColor' }} />
        </div>

        <button 
          onClick={handleBypass}
          className="btn-neon-violet" 
          style={{ width: '100%' }}
        >
          SUPER ADMIN BYPASS
        </button>

        <p style={{ marginTop: '2rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          System Version: <span style={{ color: 'var(--secondary-neon)' }}>v2.1.2</span>
        </p>
      </div>
      
      {/* Decorative Elements */}
      <div style={{
        position: 'absolute',
        bottom: '2rem',
        left: '2rem',
        fontSize: '0.7rem',
        color: 'var(--border-glass)',
        fontFamily: 'monospace'
      }}>
        SECURE LINK ESTABLISHED // ENCRYPTION: AES-256
      </div>
    </div>
  );
};

export default Auth;
