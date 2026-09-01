import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, Loader2, RefreshCw } from 'lucide-react';
import { getAuthHeaders } from '../lib/auth';
import { FOCUS_RING_CLASS } from '../lib/constants';

interface Memory {
  id: string;
  project?: string;
  memory_type?: string;
  content?: string;
  importance?: number;
  created_at?: string;
  tags?: string[];
}

interface DreamsResponse {
  memories?: unknown;
}

interface TreeNode {
  id: string;
  label: string;
  kind: 'root' | 'project' | 'type' | 'memory';
  color: string;
  x: number;
  y: number;
  memory?: Memory;
}

const TYPE_COLORS: Record<string, string> = {
  KNOWLEDGE: '#00F0FF',
  PREFERENCE: '#FF00A8',
  MISTAKE: '#FF4B4B',
  PATTERN: '#FFB400',
  SESSION_SUMMARY: '#9D00FF',
};

const API_BASE = import.meta.env.VITE_API_BASE || window.location.origin;
const MAX_DIAGRAM_MEMORIES_PER_TYPE = 12;
const ROOT_X = 70;
const PROJECT_X = 220;
const TYPE_X = 410;
const MEMORY_X = 720;
const PROJECT_START_Y = 70;
const TYPE_GAP_Y = 90;
const TYPE_OFFSET_Y = 45;
const MEMORY_OFFSET_Y = 55;
const MEMORY_GAP_Y = 44;
const PROJECT_PADDING_Y = 30;

function isMemory(value: unknown): value is Memory {
  if (!value || typeof value !== 'object') return false;
  const memory = value as Record<string, unknown>;
  return typeof memory.id === 'string'
    && (memory.project === undefined || typeof memory.project === 'string')
    && (memory.memory_type === undefined || typeof memory.memory_type === 'string')
    && (memory.content === undefined || typeof memory.content === 'string')
    && (memory.importance === undefined || typeof memory.importance === 'number')
    && (memory.created_at === undefined || typeof memory.created_at === 'string')
    && (memory.tags === undefined || (Array.isArray(memory.tags) && memory.tags.every(tag => typeof tag === 'string')));
}

function parseMemoriesResponse(value: unknown): Memory[] {
  if (!value || typeof value !== 'object') return [];
  const { memories } = value as DreamsResponse;
  return Array.isArray(memories) ? memories.filter(isMemory) : [];
}

function groupMemories(memories: Memory[]): Map<string, Map<string, Memory[]>> {
  const tree = new Map<string, Map<string, Memory[]>>();
  for (const memory of memories) {
    const project = memory.project || 'Global';
    const type = memory.memory_type || 'OTHER';
    if (!tree.has(project)) tree.set(project, new Map());
    const projectTypes = tree.get(project)!;
    if (!projectTypes.has(type)) projectTypes.set(type, []);
    projectTypes.get(type)!.push(memory);
  }
  return tree;
}

function MemoryTreeDiagram({ memories }: { memories: Memory[] }) {
  const { nodes, edges, height } = useMemo(() => {
    const tree = groupMemories(memories);
    const nodes: TreeNode[] = [];
    const edges: Array<[TreeNode, TreeNode]> = [];
    const projectEntries = Array.from(tree.entries());
    const projectLayouts = projectEntries.map(([project, types]) => {
      const typeHeights = Array.from(types.values()).map(items => Math.max(TYPE_GAP_Y, MEMORY_OFFSET_Y + Math.min(items.length, MAX_DIAGRAM_MEMORIES_PER_TYPE) * MEMORY_GAP_Y));
      return { project, types, height: typeHeights.reduce((total, value) => total + value, 0) + PROJECT_PADDING_Y };
    });
    const totalHeight = projectLayouts.reduce((total, layout) => total + layout.height, 0);
    const root: TreeNode = { id: 'root', label: 'MEMORY', kind: 'root', color: '#00F0FF', x: ROOT_X, y: Math.max(190, totalHeight / 2) };
    nodes.push(root);
    let projectTop = PROJECT_START_Y;

    projectLayouts.forEach(({ project, types, height }) => {
      const projectNode: TreeNode = {
        id: `project:${project}`, label: project, kind: 'project', color: '#00F0FF',
        x: PROJECT_X, y: projectTop + (height - PROJECT_PADDING_Y) / 2,
      };
      nodes.push(projectNode);
      edges.push([root, projectNode]);
      let typeY = projectTop;
      Array.from(types.entries()).forEach(([type, items]) => {
        const visibleItems = items.slice(0, MAX_DIAGRAM_MEMORIES_PER_TYPE);
        const typeNode: TreeNode = {
          id: `${projectNode.id}:${type}`, label: `${type.replace(/_/g, ' ')} (${items.length})`, kind: 'type',
          color: TYPE_COLORS[type] || '#888', x: TYPE_X, y: typeY + TYPE_OFFSET_Y,
        };
        nodes.push(typeNode);
        edges.push([projectNode, typeNode]);
        visibleItems.forEach((memory, memoryIndex) => {
          const memoryNode: TreeNode = {
            id: `${typeNode.id}:${memory.id}`, label: (memory.content || 'Empty memory').slice(0, 42), kind: 'memory',
            color: typeNode.color, x: MEMORY_X, y: typeNode.y + MEMORY_OFFSET_Y + memoryIndex * MEMORY_GAP_Y, memory,
          };
          nodes.push(memoryNode);
          edges.push([typeNode, memoryNode]);
        });
        typeY += Math.max(TYPE_GAP_Y, MEMORY_OFFSET_Y + visibleItems.length * MEMORY_GAP_Y);
      });
      projectTop += height;
    });

    return { nodes, edges, height: Math.max(380, ...nodes.map(node => node.y + 45)) };
  }, [memories]);

  return (
    <div style={{ overflow: 'auto', maxWidth: '100%', border: '1px solid rgba(0,240,255,0.18)', borderRadius: 16, background: 'radial-gradient(circle at 10% 50%, rgba(0,240,255,0.08), transparent 35%), #05080f' }}>
      <svg role="img" aria-label="Visual memory tree" width="980" height={height} viewBox={`0 0 980 ${height}`} preserveAspectRatio="xMinYMin meet" style={{ display: 'block', minWidth: 860 }}>
        <defs>
          <filter id="memory-tree-glow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        {edges.map(([from, to]) => <path key={`${from.id}-${to.id}`} d={`M ${from.x + 42} ${from.y} C ${(from.x + to.x) / 2} ${from.y}, ${(from.x + to.x) / 2} ${to.y}, ${to.x - 42} ${to.y}`} fill="none" stroke={to.color} strokeOpacity="0.35" strokeWidth="1.5" />)}
        {nodes.map(node => {
          const width = node.kind === 'memory' ? 190 : node.kind === 'root' ? 84 : 150;
          return <g key={node.id}>
            <rect x={node.x - width / 2} y={node.y - 17} width={width} height={34} rx="17" fill="rgba(5,8,15,0.95)" stroke={node.color} strokeWidth={node.kind === 'root' ? 2 : 1} filter={node.kind === 'root' ? 'url(#memory-tree-glow)' : undefined} />
            <text x={node.x} y={node.y + 4} textAnchor="middle" fill={node.color} fontSize={node.kind === 'memory' ? 10 : 11} fontWeight={node.kind === 'root' ? 800 : 600}>{node.label}</text>
          </g>;
        })}
      </svg>
      {memories.length > 0 && <div style={{ padding: '0 1rem 0.85rem', color: 'var(--text-muted)', fontSize: '0.72rem' }}>Diagram shows up to {MAX_DIAGRAM_MEMORIES_PER_TYPE} of each category. {Math.max(0, memories.length - nodes.filter(node => node.kind === 'memory').length)} additional entries hidden. Expand category below to view all.</div>}
    </div>
  );
}

function TreeRow({ memory }: { memory: Memory }) {
  const type = memory.memory_type || 'OTHER';
  const color = TYPE_COLORS[type] || '#888';
  return (
    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', padding: '0.65rem 0 0.65rem 2.5rem', borderLeft: '1px solid rgba(255,255,255,0.12)', marginLeft: '0.9rem' }}>
      <span style={{ width: 8, height: 8, marginTop: 7, flexShrink: 0, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}` }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: '#eee', lineHeight: 1.45 }}>{memory.content || 'Empty memory'}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: '0.25rem' }}>
          Importance: {memory.importance ?? 0}/10
          {memory.created_at ? ` · ${new Date(memory.created_at).toLocaleDateString()}` : ''}
          {memory.tags?.length ? ` · ${memory.tags.join(', ')}` : ''}
        </div>
      </div>
    </div>
  );
}

export function MemoryTreeView() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['project:Global']));
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const [selectedProject, setSelectedProject] = useState('');

  const fetchMemories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_BASE}/api/dreams/query?limit=100`, { headers });
      if (!response.ok) {
        if (response.status === 401) throw new Error('Session expired. Please log in again.');
        if (response.status >= 500) throw new Error('Memory server unavailable. Try again later.');
        throw new Error(await response.text());
      }
      const data: unknown = await response.json();
      setMemories(parseMemoriesResponse(data));
    } catch (err) {
      if (err instanceof TypeError && !navigator.onLine) {
        setError('Network connectivity issue. Check internet connection.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMemories(); }, [fetchMemories]);

  const projects = useMemo(() => Array.from(new Set(memories.map(memory => memory.project || 'Global'))).sort(), [memories]);
  const displayedMemories = useMemo(() => selectedProject ? memories.filter(memory => (memory.project || 'Global') === selectedProject) : memories, [memories, selectedProject]);
  const tree = useMemo(() => groupMemories(displayedMemories), [displayedMemories]);
  const typeCounts = useMemo(() => displayedMemories.reduce<Record<string, number>>((counts, memory) => {
    const type = memory.memory_type || 'OTHER';
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {}), [displayedMemories]);
  const maxCount = Math.max(...Object.values(typeCounts), 1);

  const toggle = (key: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <section style={{ maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h2 className="tech-font" style={{ margin: 0, color: 'var(--primary-neon)', letterSpacing: '0.08em' }}>MEMORY TREE</h2>
          <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 0' }}>Explore stored memories by project and type.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <label htmlFor="memory-project" style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Project</label>
          <select id="memory-project" value={selectedProject} onChange={event => setSelectedProject(event.target.value)} className={FOCUS_RING_CLASS} style={{ padding: '0.6rem 0.75rem', borderRadius: 8, border: '1px solid rgba(0,240,255,0.3)', background: '#05080f', color: '#fff', cursor: 'pointer' }}>
            <option value="">All projects</option>
            {projects.map(project => <option key={project} value={project}>{project}</option>)}
          </select>
          <button type="button" onClick={fetchMemories} className={FOCUS_RING_CLASS} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.9rem', borderRadius: 8, border: '1px solid rgba(0,240,255,0.3)', background: 'rgba(0,240,255,0.08)', color: 'var(--primary-neon)', cursor: 'pointer' }}>
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
      </header>

      {error && <div role="alert" style={{ color: '#FF4B4B', padding: '1rem', border: '1px solid rgba(255,75,75,0.3)', borderRadius: 10, marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
        <span>{error}</span>
        <button type="button" onClick={fetchMemories} className={FOCUS_RING_CLASS} style={{ padding: '0.45rem 0.75rem', borderRadius: 7, border: '1px solid rgba(255,75,75,0.5)', background: 'rgba(255,75,75,0.1)', color: '#FF4B4B', cursor: 'pointer' }}>Retry</button>
      </div>}

      <MemoryTreeDiagram memories={displayedMemories} />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 0.8fr) minmax(0, 1.2fr)', gap: '1.5rem', alignItems: 'start', marginTop: '1.5rem' }}>
        <div style={{ padding: '1.25rem', border: '1px solid var(--border-color)', borderRadius: 16, background: 'rgba(5,8,15,0.65)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#fff', fontWeight: 700, marginBottom: '1rem' }}><GitBranch size={18} color="var(--primary-neon)" /> Memory distribution</div>
          {Object.entries(typeCounts).map(([type, count]) => {
            const color = TYPE_COLORS[type] || '#888';
            return <div key={type} style={{ marginBottom: '0.9rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', marginBottom: '0.35rem' }}><span style={{ color }}>{type.replace('_', ' ')}</span><span style={{ color: 'var(--text-muted)' }}>{count}</span></div>
              <div style={{ height: 7, background: 'rgba(255,255,255,0.08)', borderRadius: 8 }}><div style={{ width: `${(count / maxCount) * 100}%`, height: '100%', borderRadius: 8, background: color, boxShadow: `0 0 10px ${color}` }} /></div>
            </div>;
          })}
          {!loading && displayedMemories.length === 0 && <span style={{ color: 'var(--text-muted)' }}>No memories found.</span>}
        </div>

        <div style={{ padding: '1.25rem', border: '1px solid var(--border-color)', borderRadius: 16, background: 'rgba(5,8,15,0.65)' }}>
          {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem', color: 'var(--primary-neon)' }}><Loader2 className="animate-spin" size={24} /></div> : Array.from(tree.entries()).map(([project, types]) => {
            const projectKey = `project:${project}`;
            const projectOpen = expanded.has(projectKey);
            return <div key={project} style={{ marginBottom: '0.8rem' }}>
              <button type="button" onClick={() => toggle(projectKey)} aria-expanded={projectOpen} className={FOCUS_RING_CLASS} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.7rem', border: 0, borderRadius: 8, background: 'rgba(0,240,255,0.08)', color: '#fff', textAlign: 'left', cursor: 'pointer', fontWeight: 700 }}>
                {projectOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />} {project} <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.75rem' }}>{Array.from(types.values()).flat().length}</span>
              </button>
              {projectOpen && Array.from(types.entries()).map(([type, items]) => {
                const typeKey = `${projectKey}:${type}`;
                const typeOpen = expanded.has(typeKey);
                const color = TYPE_COLORS[type] || '#888';
                return <div key={type} style={{ marginLeft: '1rem', marginTop: '0.35rem' }}>
                  <button type="button" onClick={() => toggle(typeKey)} aria-expanded={typeOpen} className={FOCUS_RING_CLASS} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', padding: '0.55rem 0.7rem', border: 0, background: 'transparent', color, textAlign: 'left', cursor: 'pointer', fontWeight: 600 }}>
                    {typeOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {type.replace('_', ' ')} <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '0.75rem' }}>{items.length}</span>
                  </button>
                  {typeOpen && items.slice(0, visibleCounts[typeKey] || MAX_DIAGRAM_MEMORIES_PER_TYPE).map(memory => <TreeRow key={memory.id} memory={memory} />)}
                  {typeOpen && items.length > (visibleCounts[typeKey] || MAX_DIAGRAM_MEMORIES_PER_TYPE) && <button type="button" onClick={() => setVisibleCounts(current => ({ ...current, [typeKey]: (current[typeKey] || MAX_DIAGRAM_MEMORIES_PER_TYPE) + MAX_DIAGRAM_MEMORIES_PER_TYPE }))} className={FOCUS_RING_CLASS} style={{ margin: '0.35rem 0 0.5rem 2.5rem', padding: '0.4rem 0.7rem', borderRadius: 7, border: '1px solid rgba(0,240,255,0.25)', background: 'rgba(0,240,255,0.06)', color: 'var(--primary-neon)', cursor: 'pointer', fontSize: '0.72rem' }}>Load more ({items.length - (visibleCounts[typeKey] || MAX_DIAGRAM_MEMORIES_PER_TYPE)} remaining)</button>}
                </div>;
              })}
            </div>;
          })}
        </div>
      </div>
    </section>
  );
}
