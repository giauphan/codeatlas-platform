import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { 
  Check, 
  Activity, 
  Loader2, 
  Globe, 
  Server, 
  Cpu, 
  Zap
} from 'lucide-react';

interface CloudIndexViewProps {
  analysis: any;
  isIndexing: boolean;
  onReindex: () => void;
  isIndexingEnabled: boolean;
  setIsIndexingEnabled: (v: boolean) => void;
}

export const CloudIndexView: React.FC<CloudIndexViewProps> = ({ 
  analysis, 
  isIndexing, 
  onReindex, 
  isIndexingEnabled, 
  setIsIndexingEnabled
}) => {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const totalFiles = (analysis?.totalFilesAnalyzed || 0) + (analysis?.totalFilesSkipped || 0);
  const coveragePercent = totalFiles > 0
    ? Math.round((analysis?.totalFilesAnalyzed || 0) / totalFiles * 100)
    : 100;

  return (
    <div style={{ height: 'calc(100vh - 8rem)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0, fontWeight: 800 }}>Neural Indexing</h1>
        <p style={{ color: 'var(--text-muted)' }}>Configure codebase indexing settings to enable structural and semantic search.</p>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: '3rem', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          
          {/* MAIN INDEXING PANEL */}
          <div className="glass-panel" style={{ padding: '2.5rem', borderRadius: '24px', border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(13, 17, 23, 0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', marginBottom: '2.5rem' }}>
              <div style={{ 
                width: '24px', height: '24px', border: '2px solid var(--primary-neon)', borderRadius: '6px', 
                display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                background: isIndexingEnabled ? 'var(--primary-neon)' : 'transparent'
              }} onClick={() => setIsIndexingEnabled(!isIndexingEnabled)}>
                {isIndexingEnabled && <Check size={16} color="#000" strokeWidth={4} />}
              </div>
              <span style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff' }}>Enable Codebase Indexing</span>
              <div style={{ padding: '0.25rem 0.6rem', borderRadius: '100px', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                <Activity size={12} style={{ display: 'inline', marginRight: '4px' }} /> Active Monitoring
              </div>
            </div>

            <div style={{ marginBottom: '2.5rem' }}>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '0.75rem', textTransform: 'uppercase' }}>Status</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ 
                  width: '12px', height: '12px', borderRadius: '50%', 
                  background: isIndexing ? 'var(--primary-neon)' : 'rgba(255,255,255,0.2)',
                  boxShadow: isIndexing ? '0 0 10px var(--primary-neon)' : 'none'
                }} />
                <span style={{ fontWeight: 600, color: isIndexing ? '#fff' : 'var(--text-muted)' }}>
                  {isIndexing ? 'Scanning source files...' : isIndexingEnabled ? 'Standby - Watching for changes' : 'Code indexing is disabled'}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div style={{ cursor: 'pointer' }} onClick={() => setShowAdvanced(!showAdvanced)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', color: '#fff', fontWeight: 700 }}>
                  <motion.div animate={{ rotate: showAdvanced ? 90 : 0 }}>{"> "}</motion.div> Setup Information
                </div>
              </div>
              
              <div style={{ cursor: 'pointer' }} onClick={() => setShowAdvanced(!showAdvanced)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', color: '#fff', fontWeight: 700 }}>
                  <motion.div animate={{ rotate: showAdvanced ? 90 : 0 }}>{"> "}</motion.div> Advanced Configuration
                </div>
              </div>

              {showAdvanced && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} style={{ padding: '1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '12px', fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Indexing Depth: Level 4 (Full Analysis)<br/>
                  Exclusions: node_modules, .git, build, dist<br/>
                  Target Directory: /home/biibon/CodeAtlas
                </motion.div>
              )}
            </div>

            <div style={{ marginTop: '3rem', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn-neon-cyan" style={{ padding: '0.75rem 2rem' }} onClick={onReindex} disabled={isIndexing}>
                {isIndexing ? <Loader2 className="animate-spin" size={20} /> : 'Save & Index Now'}
              </button>
            </div>
          </div>

          {/* LOG CONSOLE */}
          <div className="glass-panel" style={{ flex: 1, padding: '1.5rem', borderRadius: '24px', background: '#05080f', border: '1px solid rgba(255,255,255,0.05)', fontFamily: 'monospace' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--primary-neon)' }}>INDEXING_LOG_STREAM</span>
              <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)' }}>NODE_01</span>
            </div>
            <div style={{ fontSize: '0.9rem', color: 'rgba(0, 240, 255, 0.8)', lineHeight: 1.6 }}>
              {isIndexing ? (
                <motion.div animate={{ opacity: [0.5, 1] }} transition={{ repeat: Infinity, duration: 0.8 }}>
                  [SCAN] Crawling directory structure...<br/>
                  [PARS] Analyzing 286 AST nodes...<br/>
                  [GRAPH] Updating Knowledge Network links...<br/>
                  [EMBED] Generating semantic vectors...
                </motion.div>
              ) : (
                <>
                  [READY] System monitoring active<br/>
                  [INFO] Last index: {new Date().toLocaleTimeString()}<br/>
                  [INFO] Vector database synchronized ({coveragePercent}% coverage)
                </>
              )}
            </div>
          </div>
        </div>

        {/* SIDEBAR STATS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="glass-panel" style={{ padding: '2rem', borderRadius: '28px', border: '1px solid rgba(255,255,255,0.05)' }}>
            <h3 className="tech-font" style={{ fontSize: '1.1rem', marginBottom: '1.5rem', fontWeight: 800 }}>Index Statistics</h3>
            {[
              { label: 'Scanned Files', value: analysis?.totalFilesAnalyzed || analysis?.stats?.totalFiles || 0, icon: Globe },
              { label: 'Neural Nodes', value: analysis?.graph?.nodes?.length || 0, icon: Server },
              { label: 'Logic Units', value: analysis?.stats?.totalFunctions || analysis?.stats?.totalClasses || analysis?.entityCounts?.functions || 0, icon: Cpu },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
                <div style={{ color: 'var(--primary-neon)' }}><item.icon size={20} /></div>
                <div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 900 }}>{item.value}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>{item.label}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="glass-panel" style={{ padding: '1.5rem', borderRadius: '24px', background: 'rgba(255, 180, 0, 0.05)', border: '1px solid rgba(255, 180, 0, 0.1)' }}>
            <div style={{ color: '#FFB400', fontSize: '0.8rem', fontWeight: 800, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Zap size={14} /> ADVISORY
            </div>
            <p style={{ fontSize: '0.8rem', color: 'rgba(255, 180, 0, 0.8)', margin: 0, lineHeight: 1.4 }}>
              Automatic indexing is optimized for local development. For large enterprise monorepos, use the "Selective Scan" in Advanced Configuration.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
