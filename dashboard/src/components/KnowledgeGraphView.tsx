import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
  Box, Code2, Layers, Activity, Search,
  Maximize2, Minimize2, Trash2
} from 'lucide-react';
import { SphericalKnowledgeGraph } from './KnowledgeNetwork3D';
import { getAuthHeaders } from '../lib/auth';

interface AnalysisData {
  analysis?: AnalysisData;
  stats?: {
    totalFiles?: number; totalModules?: number; totalClasses?: number;
    totalFunctions?: number; totalVariables?: number; loc?: number;
  };
  entityCounts?: {
    modules?: number; functions?: number; classes?: number;
    variables?: number; dependencies?: number; circularDeps?: number; deadCode?: number;
  };
  totalFilesAnalyzed?: number;
  graph: { nodes: any[]; links: any[] };
}

interface KnowledgeGraphViewProps {
  analysis: AnalysisData | null;
  projects?: { name: string; dir: string }[];
  selectedProjectDir?: string;
  onProjectChange?: (dir: string) => void;
  onDeleteProject?: () => void;
}

const API_BASE = window.location.origin.includes('localhost:5173')
  ? 'http://localhost:8080'
  : window.location.origin;

export const KnowledgeGraphView: React.FC<KnowledgeGraphViewProps> = ({ 
  analysis, projects, selectedProjectDir,
  onProjectChange, onDeleteProject
}) => {
  const [hoveredNode, setHoveredNode] = useState<any>(null);
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState(['module', 'function', 'class', 'variable']);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [concepts, setConcepts] = useState<any[]>([]);
  const [dreams, setDreams] = useState<any[]>([]);

  const graphContainerRef = React.useRef<HTMLDivElement>(null);

  // Fetch concepts and dreams
  useEffect(() => {
    (async () => {
      const headers = await getAuthHeaders();
      fetch(`${API_BASE}/api/concepts/search?limit=30`, { headers })
        .then(r => r.json()).then(d => setConcepts(d.concepts || [])).catch(() => {});
      fetch(`${API_BASE}/api/dreams/query?limit=30`, { headers })
        .then(r => r.json()).then(d => setDreams(d.memories || [])).catch(() => {});
    })();
  }, []);

  const toggleFilter = (type: string) => {
    setActiveFilters(prev => prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]);
  };

  const filters = [
    { id: 'module', label: 'Modules', icon: <Box size={14} />, color: '#00F0FF' },
    { id: 'function', label: 'Functions', icon: <Code2 size={14} />, color: '#FF00A8' },
    { id: 'class', label: 'Classes', icon: <Layers size={14} />, color: '#FFB400' },
    { id: 'variable', label: 'Variables', icon: <Activity size={14} />, color: '#00FF94' },
  ];

  const entityCounts = analysis?.entityCounts;
  const totalFilesAnalyzed = analysis?.totalFilesAnalyzed;

  return (
    <div style={{ display: 'flex', height: '100%', gap: '1.5rem' }}>
      {/* Main graph area */}
      <div
        ref={graphContainerRef}
        style={{ flex: 1, position: 'relative', overflow: 'hidden', borderRadius: '32px' }}
      >
        {/* Search bar */}
        <div style={{ position: 'absolute', top: '1.5rem', left: '1.5rem', zIndex: 10 }}>
          <div style={{ position: 'relative', width: '260px' }}>
            <Search size={18} style={{ position: 'absolute', left: '1rem', top: '0.8rem', color: 'var(--text-muted)' }} />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search sphere…"
              aria-label="Search knowledge graph sphere"
              style={{
                width: '100%', padding: '0.6rem 1rem 0.6rem 2.8rem', borderRadius: '12px',
                border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.7)',
                color: '#fff', fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box',
                backdropFilter: 'blur(8px)',
              }}
            />
          </div>
        </div>

        {/* Filter chips */}
        <div style={{ position: 'absolute', top: '1.5rem', right: '1.5rem', zIndex: 10, display: 'flex', gap: '0.5rem' }}>
          {filters.map(f => (
            <div
              key={f.id}
              onClick={() => toggleFilter(f.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.8rem',
                borderRadius: '20px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 600,
                background: activeFilters.includes(f.id) ? `${f.color}22` : 'rgba(255,255,255,0.05)',
                border: `1px solid ${activeFilters.includes(f.id) ? f.color : 'transparent'}`,
                color: activeFilters.includes(f.id) ? f.color : 'var(--text-muted)',
                transition: 'all 0.2s',
              }}
            >
              {f.icon} {f.label}
            </div>
          ))}
        </div>

        {/* 3D Sphere */}
        {analysis && (
          <SphericalKnowledgeGraph
            analysis={analysis}
            concepts={concepts}
            dreams={dreams}
            searchQuery={searchQuery}
            activeFilters={activeFilters}
            onNodeHover={(n) => setHoveredNode(n)}
            onNodeClick={(n) => setSelectedNode(n)}
          />
        )}
        {!analysis && (
          <div style={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            color: 'var(--text-muted)', fontSize: '1.2rem', textAlign: 'center'
          }}>
            No analysis data available for the selected project.
            <br />
            Select a project with analysis or sync one from the desktop client.
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div style={{
        width: '300px', minWidth: '300px', padding: '2rem', borderRadius: '32px',
        border: '1px solid rgba(255,255,255,0.05)', background: 'rgba(5,8,15,0.65)',
        display: 'flex', flexDirection: 'column', gap: '1.5rem', overflowY: 'auto', height: 'fit-content'
      }}>
        {/* Stats */}
        {analysis && (
          <div>
            <h3 style={{ margin: '0 0 1rem', fontSize: '0.8rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Network Stats
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              {entityCounts && Object.entries(entityCounts).map(([key, val]) => (
                <div key={key} style={{ padding: '0.75rem', background: 'rgba(0,0,0,0.3)', borderRadius: '10px' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{key.replace(/([A-Z])/g, ' $1')}</div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#fff' }}>{String(val)}</div>
                </div>
              ))}
            </div>
            {totalFilesAnalyzed !== undefined && (
              <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Files analyzed: {totalFilesAnalyzed}
              </div>
            )}
          </div>
        )}

        {/* Selected node detail */}
        {selectedNode && (
          <div style={{ padding: '1rem', background: 'rgba(0,240,255,0.05)', borderRadius: '12px', border: '1px solid rgba(0,240,255,0.15)' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--primary-neon)', textTransform: 'uppercase', fontWeight: 700 }}>
              {selectedNode.type || 'entity'}
            </div>
            <div style={{ fontSize: '1rem', fontWeight: 700, marginTop: '0.25rem', wordBreak: 'break-word' }}>
              {selectedNode.label || selectedNode.name || selectedNode.id}
            </div>
            {selectedNode.file && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                📁 {selectedNode.file}
              </div>
            )}
            {selectedNode.confidence !== undefined && (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                Confidence: {(selectedNode.confidence * 100).toFixed(0)}%
              </div>
            )}
          </div>
        )}

        {/* Project selector */}
        {projects && projects.length > 0 && (
          <div>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem', display: 'block' }}>
              Project
            </label>
            <select
              value={selectedProjectDir}
              onChange={(e) => onProjectChange?.(e.target.value)}
              style={{
                width: '100%', padding: '0.6rem 1rem', borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.4)',
                color: '#fff', fontSize: '0.9rem', outline: 'none',
              }}
            >
              {projects.map(p => (
                <option key={p.dir} value={p.dir}>{p.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Delete */}
        {selectedProjectDir && onDeleteProject && (
          <button
            onClick={() => {
              if (window.confirm("Delete project index data?")) onDeleteProject();
            }}
            style={{
              width: '100%', padding: '0.6rem', borderRadius: '10px',
              background: 'rgba(255,75,75,0.1)', border: '1px solid #FF4B4B',
              color: '#FF4B4B', fontWeight: 700, cursor: 'pointer', fontSize: '0.8rem',
            }}
          >
            Delete Project Index
          </button>
        )}
      </div>
    </div>
  );
};
