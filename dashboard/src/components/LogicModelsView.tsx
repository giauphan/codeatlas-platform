import React from 'react';
import { 
  Network, 
  Cpu, 
  Zap 
} from 'lucide-react';

interface LogicModelsViewProps {
  analysis: any;
}

export const LogicModelsView: React.FC<LogicModelsViewProps> = ({ analysis }) => (
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
