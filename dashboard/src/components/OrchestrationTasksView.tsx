import { useState, useEffect, useCallback } from 'react';
import { Network, Search, Loader2, AlertCircle, CheckCircle2, CircleDot, GitBranch, Lightbulb, XCircle, RefreshCw } from 'lucide-react';
import { motion } from 'framer-motion';
import { getAuthHeaders } from '../lib/auth'; // Reusing auth headers utility
import type { A2AOrchestrationTask, OrchestrationState } from '../../../src/types/a2a'; // Importing types

export function OrchestrationTasksView() {
  const [tasks, setTasks] = useState<A2AOrchestrationTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterState, setFilterState] = useState<OrchestrationState | 'all'>('all');

  const API_BASE = window.location.origin.includes('localhost:5173')
    ? 'http://localhost:8080'
    : window.location.origin;

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/orchestration/tasks`, { headers });
      if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errorText}`);
      }
      const data = await resp.json();
      setTasks(data.tasks || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [API_BASE]);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 10000); // Poll for updates every 10 seconds
    return () => clearInterval(interval);
  }, [fetchTasks]);

  const handleSearch = () => fetchTasks(); // Re-fetch all and filter locally for simplicity, or add query param if API supports

  const getBadgeColor = (state: OrchestrationState) => {
    switch (state) {
      case 'created': return 'bg-blue-600';
      case 'assigned': return 'bg-yellow-600';
      case 'implemented': return 'bg-orange-600';
      case 'fixes_needed': return 'bg-red-600';
      case 'approved': return 'bg-green-600';
      default: return 'bg-gray-600';
    }
  };

  const getIconForState = (state: OrchestrationState) => {
    switch (state) {
      case 'created': return <CircleDot size={16} />;
      case 'assigned': return <GitBranch size={16} />;
      case 'implemented': return <CheckCircle2 size={16} />;
      case 'fixes_needed': return <XCircle size={16} />;
      case 'approved': return <CheckCircle2 size={16} />;
      default: return <Network size={16} />;
    }
  };

  const filteredTasks = tasks.filter(task => {
    const matchesSearch = searchQuery.trim() === '' ||
                          task.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          task.orchestrationTaskId.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          task.developerAgentId?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          task.leaderAgentId.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesState = filterState === 'all' || task.state === filterState;
    return matchesSearch && matchesState;
  });

  const availableStates: (OrchestrationState | 'all')[] = ['all', 'created', 'assigned', 'implemented', 'fixes_needed', 'approved'];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ padding: '2rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Network size={28} /> Orchestration Tasks
          </h2>
          <p style={{ color: 'var(--text-muted)', margin: '0.5rem 0 0' }}>
            Manage and track A2A orchestration workflows.
          </p>
        </div>
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={fetchTasks}
          disabled={loading}
          style={{
            padding: '0.75rem 1.5rem', background: 'linear-gradient(135deg, #00f0ff, #7c3aed)',
            border: 'none', borderRadius: '12px', color: '#fff', fontWeight: 700, fontSize: '0.9rem',
            cursor: loading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? <Loader2 size={18} className="spin" /> : <RefreshCw size={18} />}
          {loading ? 'Refreshing…' : 'Refresh Tasks'}
        </motion.button>
      </div>

      {/* Search & filters */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '280px', position: 'relative' }}>
          <Search size={18} style={{ position: 'absolute', left: '12px', top: '12px', color: 'var(--text-muted)' }} />
          <input
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Search tasks by ID, description, or agent…"
            aria-label="Search orchestration tasks"
            style={{
              width: '100%', padding: '0.7rem 1rem 0.7rem 2.5rem', borderRadius: '10px',
              border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.3)',
              color: '#fff', fontSize: '0.95rem', outline: 'none', boxSizing: 'border-box'
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {availableStates.map(state => (
            <button
              key={state}
              onClick={() => setFilterState(state)}
              style={{
                padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)',
                background: filterState === state ? 'rgba(0,240,255,0.15)' : 'rgba(0,0,0,0.2)',
                color: filterState === state ? 'var(--primary-neon)' : 'var(--text-muted)',
                cursor: 'pointer', fontWeight: 600, fontSize: '0.85rem', transition: 'all 0.2s',
              }}
            >
              {state.charAt(0).toUpperCase() + state.slice(1).replace('_', ' ')}
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
      {!loading && !error && filteredTasks.length === 0 && (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)' }}>
          <Lightbulb size={48} style={{ opacity: 0.3, marginBottom: '1rem' }} />
          <p style={{ fontSize: '1.1rem' }}>No orchestration tasks found.</p>
        </div>
      )}

      {/* Task cards */}
      {!loading && !error && filteredTasks.length > 0 && (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {filteredTasks.map(task => (
            <motion.div
              key={task.orchestrationTaskId}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="glass-panel"
              style={{ padding: '1.25rem', borderRadius: '14px', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                    <strong style={{ fontSize: '1.1rem' }}>{task.description}</strong>
                    <span style={{
                      fontSize: '0.75rem', padding: '0.2rem 0.6rem', borderRadius: '6px',
                      background: `var(--${task.state}-badge-bg, rgba(255,255,255,0.1))`, // Use CSS variables for dynamic colors
                      color: `var(--${task.state}-badge-color, #fff)`,
                      fontWeight: 700, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '0.3rem',
                    }}>
                      {getIconForState(task.state)} {task.state.replace('_', ' ')}
                    </span>
                  </div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.6, margin: '0.5rem 0' }}>
                    Task ID: {task.orchestrationTaskId}
                  </p>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.6, margin: '0.5rem 0' }}>
                    Leader: {task.leaderAgentId} | Developer: {task.developerAgentId || 'N/A'}
                  </p>
                  {task.feedback && (
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-red)', lineHeight: 1.6, margin: '0.5rem 0' }}>
                      Feedback: {task.feedback}
                    </p>
                  )}
                  {task.prUrl && (
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.6, margin: '0.5rem 0' }}>
                      PR: <a href={task.prUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary-neon)' }}>{task.prUrl}</a>
                    </p>
                  )}
                  {task.artifacts && task.artifacts.length > 0 && (
                    <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      <strong>Artifacts:</strong>
                      {task.artifacts.map((artifact, idx) => (
                        <p key={idx} style={{ margin: '0.2rem 0', wordBreak: 'break-all' }}>
                          - {artifact.name}: {(artifact.parts[0]?.kind === 'text' ? artifact.parts[0].text : 'Non-text artifact').slice(0, 100)}...
                        </p>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
                    <span>Created: {new Date(task.createdAt).toLocaleString()}</span>
                    <span>Updated: {new Date(task.updatedAt).toLocaleString()}</span>
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