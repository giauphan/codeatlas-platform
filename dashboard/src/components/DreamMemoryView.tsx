import { useState, useEffect, useCallback } from 'react';
import { Brain, Search, Trash2, AlertCircle, Loader2, Database } from 'lucide-react';
import { motion } from 'framer-motion';


interface DreamMemory {
  id: string;
  session_id: string;
  project: string;
  memory_type: string;
  content: string;
  importance: number;
  created_at: string;
}

export function DreamMemoryView() {
  const [memories, setMemories] = useState<DreamMemory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<string[]>(['KNOWLEDGE', 'PREFERENCE', 'MISTAKE', 'PATTERN']);
  const [showAll, setShowAll] = useState(true);
  // user removed — auth handled via sessionStorage tokens
  const [firebaseReady, setFirebaseReady] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;

  // Session token from sessionStorage (set by API key or Firebase sign-in)
  useEffect(() => {
    if (sessionStorage.getItem('ca_api_key')) {
      setFirebaseReady(true);
    }
  }, []);

  const fetchMemories = useCallback(async (query?: string, pageNum?: number) => {
    if (!firebaseReady) return;
    setLoading(true);
    setError(null);
    const p = pageNum ?? page;
    try {
      let headers: Record<string, string> = {};
      const savedKey = sessionStorage.getItem('ca_api_key');
      if (savedKey) {
        if (savedKey.startsWith('ca_')) {
          headers['x-api-key'] = savedKey;
        } else {
          headers['Authorization'] = `Bearer ${savedKey}`;
        }
      } else {
        setError('Please log in to view Dream Memories');
        setLoading(false);
        return;
      }
      const params = new URLSearchParams();
      if (query && query.trim()) params.set('query', query.trim());
      if (!showAll) params.set('project', 'GolikeTool');
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(p * PAGE_SIZE));

      const resp = await fetch(`/api/dreams/query?${params}`, { headers });
      if (!resp.ok) throw new Error(resp.status === 403 ? 'API key required' : await resp.text());
      const data = await resp.json();
      setMemories(data.memories || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [showAll, firebaseReady, page]);

  useEffect(() => {
    if (firebaseReady) fetchMemories(searchQuery, 0);
  }, [firebaseReady]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(0);
    fetchMemories(searchQuery, 0);
  };

  const goToPage = (p: number) => {
    if (p < 0) return;
    setPage(p);
    fetchMemories(searchQuery, p);
  };

  const toggleType = (type: string) => {
    setSelectedTypes(prev =>
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  const hasPrev = page > 0;
  const hasNext = memories.length >= PAGE_SIZE;

  const filteredMemories = memories.filter(m => selectedTypes.includes(m.memory_type));

  const typeColors: Record<string, string> = {
    KNOWLEDGE: '#00F0FF',
    PREFERENCE: '#FF00A8',
    MISTAKE: '#FF4B4B',
    PATTERN: '#FFB400',
  };

  return (
    <div style={{ height: 'calc(100vh - 8rem)', display: 'flex', flexDirection: 'column', overflowX: 'hidden' }}>
      <header style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 className="tech-font" style={{ fontSize: '2.5rem', margin: 0, fontWeight: 800 }}>
            <Brain size={32} style={{ marginRight: '0.75rem', verticalAlign: 'middle', color: 'var(--primary-neon)' }} />
            Dream Memory
          </h1>
          <p style={{ color: 'var(--text-muted)' }}>Semantic memory search with NVIDIA embeddings — query past learnings, mistakes, and patterns.</p>
        </div>
      </header>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <form onSubmit={handleSearch} style={{ flex: 1, position: 'relative', minWidth: '250px' }}>
          <Search size={18} style={{ position: 'absolute', left: '1.25rem', top: '1.1rem', color: 'var(--text-muted)' }} />
          <input
            type="text" className="glass-input" placeholder="Search memories semantically..."
            aria-label="Search memories semantically"
            style={{ paddingLeft: '3.25rem', width: '100%' }}
            value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
          />
        </form>
        <button onClick={() => { setShowAll(!showAll); fetchMemories(searchQuery); }}
          style={{
            padding: '0.75rem 1.25rem', borderRadius: '12px', border: showAll ? '1px solid var(--primary-neon)' : '1px solid rgba(255,255,255,0.1)',
            background: showAll ? 'rgba(0,240,255,0.1)' : 'rgba(255,255,255,0.05)', color: '#fff', fontWeight: 700, cursor: 'pointer'
          }}>
          {showAll ? 'All Projects' : 'GolikeTool'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        {['KNOWLEDGE', 'PREFERENCE', 'MISTAKE', 'PATTERN'].map(type => (
          <button
            key={type}
            type="button"
            onClick={() => toggleType(type)}
            aria-pressed={selectedTypes.includes(type)}
            style={{
              padding: '0.4rem 1rem', borderRadius: '100px', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700,
              background: selectedTypes.includes(type) ? `${typeColors[type]}22` : 'rgba(255,255,255,0.05)',
              border: `1px solid ${selectedTypes.includes(type) ? typeColors[type] : 'rgba(255,255,255,0.1)'}`,
              color: selectedTypes.includes(type) ? typeColors[type] : 'var(--text-muted)',
              outline: 'none'
            }}
            className="focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-opacity-50"
          >
            {type}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {!firebaseReady && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '200px', gap: '1rem', color: 'var(--text-muted)' }}>
            <Loader2 className="animate-spin" size={24} /> Initializing...
          </div>
        )}

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '200px', gap: '1rem', color: 'var(--primary-neon)' }}>
            <Loader2 className="animate-spin" size={24} /> Querying Oracle 26ai + NVIDIA embeddings...
          </div>
        )}

        {error && (
          <div className="glass-panel" style={{ padding: '2rem', borderRadius: '20px', border: '1px solid #FF4B4B', textAlign: 'center' }}>
            <AlertCircle size={32} color="#FF4B4B" style={{ marginBottom: '1rem' }} />
            <div style={{ color: '#FF4B4B', fontWeight: 700 }}>{error}</div>
          </div>
        )}

        {!loading && !error && filteredMemories.length === 0 && firebaseReady && (
          <div className="glass-panel" style={{ padding: '3rem', borderRadius: '20px', textAlign: 'center' }}>
            <Brain size={48} style={{ color: 'var(--text-muted)', marginBottom: '1rem', opacity: 0.3 }} />
            <div style={{ color: 'var(--text-muted)', fontSize: '1.1rem', fontWeight: 600 }}>No memories found</div>
            <p style={{ color: 'var(--text-muted)', opacity: 0.6, marginTop: '0.5rem' }}>
              Use the <code>save_dream_memory</code> MCP tool to persist learnings, or try a different search query.
            </p>
          </div>
        )}

        {!loading && filteredMemories.map((mem) => (
          <motion.div
            key={mem.id} layout
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="glass-panel" style={{
              padding: '1.5rem', borderRadius: '16px',
              border: `1px solid ${typeColors[mem.memory_type] || 'rgba(255,255,255,0.05)'}33`
            }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{
                  padding: '0.2rem 0.6rem', borderRadius: '100px', fontSize: '0.7rem', fontWeight: 800,
                  background: `${typeColors[mem.memory_type]}22`, color: typeColors[mem.memory_type],
                  border: `1px solid ${typeColors[mem.memory_type]}44`
                }}>
                  {mem.memory_type}
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {new Date(mem.created_at).toLocaleString()}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Database size={12} color="var(--text-muted)" />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Importance: {mem.importance}/10</span>
              </div>
            </div>
            <div style={{ fontSize: '0.95rem', color: '#fff', lineHeight: 1.5, marginBottom: '0.5rem' }}>{mem.content}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {mem.project} · session: {mem.session_id}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Pagination */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1rem', padding: '0.75rem 0', borderTop: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }}>
        <button onClick={() => goToPage(page - 1)} disabled={!hasPrev}
          style={{
            padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.2)',
            background: hasPrev ? 'rgba(0,240,255,0.1)' : 'rgba(255,255,255,0.05)',
            color: hasPrev ? 'var(--primary-neon)' : 'var(--text-muted)',
            cursor: hasPrev ? 'pointer' : 'default', fontWeight: 700, fontSize: '0.85rem'
          }}>
          ← Prev
        </button>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontWeight: 600 }}>
          Page {page + 1}
        </span>
        <button onClick={() => goToPage(page + 1)} disabled={!hasNext}
          style={{
            padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.2)',
            background: hasNext ? 'rgba(0,240,255,0.1)' : 'rgba(255,255,255,0.05)',
            color: hasNext ? 'var(--primary-neon)' : 'var(--text-muted)',
            cursor: hasNext ? 'pointer' : 'default', fontWeight: 700, fontSize: '0.85rem'
          }}>
          Next →
        </button>
      </div>
    </div>
  );
}
