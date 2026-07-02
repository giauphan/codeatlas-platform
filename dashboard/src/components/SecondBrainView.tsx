import { useState, useEffect, useCallback } from 'react';
import { Brain, Search, Lightbulb, TrendingUp, Archive, AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';

interface Concept {
  id: string;
  label: string;
  description: string;
  category: string;
  confidence: number;
  evidenceCount: number;
  project: string;
}

export function SecondBrainView() {
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [consolidating, setConsolidating] = useState(false);
  const [consolidationMsg, setConsolidationMsg] = useState<string | null>(null);

  const API_BASE = window.location.origin.includes('localhost:5173')
    ? 'http://localhost:8080'
    : window.location.origin;

  const getAuthHeaders = async () => {
    const apiKey = sessionStorage.getItem('ca_api_key');
    const headers: Record<string, string> = {};
    if (apiKey) headers['x-api-key'] = apiKey;
    return headers;
  };

  const fetchConcepts = useCallback(async (query?: string) => {
    setLoading(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const params = new URLSearchParams({ limit: '50' });
      if (query?.trim()) params.set('query', query.trim());
      const resp = await fetch(`${API_BASE}/api/concepts/search?${params}`, { headers });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      const list: Concept[] = data.concepts || [];
      setConcepts(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [API_BASE]);

  useEffect(() => {
    fetchConcepts();
  }, [fetchConcepts]);

  const handleSearch = () => fetchConcepts(searchQuery);

  const handleConsolidate = async () => {
    setConsolidating(true);
    setConsolidationMsg(null);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/consolidation/run`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations: ['dedup', 'extract_concepts', 'score'] }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const data = await resp.json();
      setConsolidationMsg(
        `✅ Merged ${data.dreamsMerged} dreams, created ${data.conceptsCreated} concepts`
      );
      fetchConcepts(); // Refresh list
    } catch (err) {
      setConsolidationMsg(`❌ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConsolidating(false);
    }
  };

  const filtered = searchQuery.trim()
    ? concepts
    : concepts.filter(c => selectedCategory === 'all' || c.category === selectedCategory);

  const categories = ['all', ...new Set(concepts.map(c => c.category))];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ padding: '2rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Brain size={28} /> Second Brain
          </h2>
          <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 0' }}>
            Extracted knowledge concepts from dream memories
          </p>
        </div>
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={handleConsolidate}
          disabled={consolidating}
          style={{
            padding: '0.75rem 1.5rem', background: 'linear-gradient(135deg, #00f0ff, #7c3aed)',
            border: 'none', borderRadius: '12px', color: '#fff', fontWeight: 700, fontSize: '0.9rem',
            cursor: consolidating ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem',
            opacity: consolidating ? 0.6 : 1,
          }}
        >
          {consolidating ? <Loader2 size={18} className="spin" /> : <RefreshCw size={18} />}
          {consolidating ? 'Consolidating…' : 'Run Consolidation'}
        </motion.button>
      </div>

      {consolidationMsg && (
        <div style={{
          padding: '0.75rem 1rem', background: 'rgba(0,240,255,0.08)', borderRadius: '10px',
          border: '1px solid rgba(0,240,255,0.2)', marginBottom: '1.5rem', fontSize: '0.9rem'
        }}>
          {consolidationMsg}
        </div>
      )}

      {/* Search & filters */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '280px', position: 'relative' }}>
          <Search size={18} style={{ position: 'absolute', left: '12px', top: '12px', color: 'var(--text-muted)' }} />
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Search concepts…"
            style={{
              width: '100%', padding: '0.7rem 1rem 0.7rem 2.5rem', borderRadius: '10px',
              border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.3)',
              color: '#fff', fontSize: '0.95rem', outline: 'none', boxSizing: 'border-box'
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              style={{
                padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)',
                background: selectedCategory === cat ? 'rgba(0,240,255,0.15)' : 'rgba(0,0,0,0.2)',
                color: selectedCategory === cat ? 'var(--primary-neon)' : 'var(--text-muted)',
                cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem', transition: 'all 0.2s',
              }}
            >
              {cat === 'all' ? 'All' : cat}
            </button>
          ))}
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: 'center', padding: '3rem' }}>
          <Loader2 size={32} className="spin" style={{ color: 'var(--primary-neon)' }} />
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: '1rem', background: 'rgba(255,50,50,0.1)', border: '1px solid rgba(255,50,50,0.3)', borderRadius: '10px', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <AlertCircle size={20} color="#ff4b4b" />
          <span>{error}</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)' }}>
          <Lightbulb size={48} style={{ opacity: 0.3, marginBottom: '1rem' }} />
          <p style={{ fontSize: '1.1rem' }}>No concepts yet. Run consolidation first.</p>
        </div>
      )}

      {/* Concept cards */}
      {!loading && !error && filtered.length > 0 && (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {filtered.map(concept => (
            <motion.div
              key={concept.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass-panel"
              style={{ padding: '1.25rem', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                    <strong style={{ fontSize: '1.1rem' }}>{concept.label}</strong>
                    <span style={{
                      fontSize: '0.75rem', padding: '0.2rem 0.6rem', borderRadius: '6px',
                      background: concept.category === 'lesson' ? 'rgba(124,58,237,0.2)' :
                                   concept.category === 'pattern' ? 'rgba(0,240,255,0.2)' :
                                   'rgba(255,200,0,0.2)',
                      color: concept.category === 'lesson' ? '#a78bfa' :
                             concept.category === 'pattern' ? '#00f0ff' : '#fbbf24',
                      fontWeight: 700, textTransform: 'uppercase'
                    }}>
                      {concept.category}
                    </span>
                  </div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.6, margin: '0.5rem 0' }}>
                    {concept.description.slice(0, 300)}
                    {concept.description.length > 300 ? '…' : ''}
                  </p>
                  <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <TrendingUp size={14} /> Confidence: {(concept.confidence * 100).toFixed(0)}%
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <Archive size={14} /> Evidence: {concept.evidenceCount}
                    </span>
                    <span>📁 {concept.project}</span>
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </motion.div>
  );
}
