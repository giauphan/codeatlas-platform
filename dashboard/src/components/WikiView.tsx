import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BookOpen,
  Folder,
  FileText,
  ChevronRight,
  ChevronDown,
  Sparkles,
  Send,
  RefreshCw,
  Loader2,
  Bot,
  HelpCircle,
  Code,
  Layers,
  CheckCircle,
  AlertCircle,
  Settings,
  Save,
  Trash2
} from 'lucide-react';
import { getAuthHeaders } from '../lib/auth';
import { FOCUS_RING_CLASS } from '../lib/constants';

interface WikiNode {
  path: string;
  title: string;
  summary?: string;
  children?: WikiNode[];
}

interface WikiTreeResponse {
  projectName: string;
  root: WikiNode[];
  totalPages: number;
  lastGeneratedAt?: string;
}


interface WikiLLMConfigProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

interface WikiPage {
  id: string;
  projectName: string;
  path: string;
  title: string;
  summary?: string;
  content: string;
  diagramData?: string;
  parentPath?: string;
  orderIndex: number;
}

interface WikiViewProps {
  projects?: { name: string; dir: string }[];
  selectedProjectDir?: string;
  onProjectChange?: (dir: string) => void;
}

const API_BASE = window.location.origin.includes('localhost:5173')
  ? 'http://localhost:8080'
  : window.location.origin;

export const WikiView: React.FC<WikiViewProps> = ({
  projects = [],
  selectedProjectDir = '',
  onProjectChange
}) => {
  // Use current selected project or fallback
  const [currentProject, setCurrentProject] = useState<string>(() => {
    if (selectedProjectDir) {
      const match = projects.find(p => p.dir === selectedProjectDir);
      return match ? match.name : selectedProjectDir.split('/').pop() || 'default';
    }
    return projects.length > 0 ? projects[0].name : 'default';
  });

  useEffect(() => {
    if (selectedProjectDir) {
      const match = projects.find(p => p.dir === selectedProjectDir);
      setCurrentProject(match ? match.name : selectedProjectDir.split('/').pop() || 'default');
    } else if (projects.length > 0 && currentProject === 'default') {
      setCurrentProject(projects[0].name);
    }
  }, [selectedProjectDir, projects]);

  const [tree, setTree] = useState<WikiTreeResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>('/overview');
  const [page, setPage] = useState<WikiPage | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Generation Modal State
  const [showGenModal, setShowGenModal] = useState(false);
  const [genProvider, setGenProvider] = useState(() => localStorage.getItem('ca_wiki_provider') || 'mock');
  const [genModel, setGenModel] = useState(() => localStorage.getItem('ca_wiki_model') || 'default');
  const [genApiKey, setGenApiKey] = useState(() => localStorage.getItem('ca_wiki_api_key') || '');
  const [genBaseUrl, setGenBaseUrl] = useState(() => localStorage.getItem('ca_wiki_base_url') || '');


  // Saved Config Profiles
  const [profiles, setProfiles] = useState<WikiLLMConfigProfile[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('ca_wiki_saved_profiles') || '[]');
    } catch { return []; }
  });
  const [activeProfileId, setActiveProfileId] = useState(() => localStorage.getItem('ca_wiki_active_profile_id') || '');
  const [profileNameInput, setProfileNameInput] = useState('');

  // Save to config continuously
  useEffect(() => {
    localStorage.setItem('ca_wiki_saved_profiles', JSON.stringify(profiles));
  }, [profiles]);
  useEffect(() => {
    localStorage.setItem('ca_wiki_active_profile_id', activeProfileId);
  }, [activeProfileId]);

  useEffect(() => { localStorage.setItem('ca_wiki_provider', genProvider); }, [genProvider]);
  useEffect(() => { localStorage.setItem('ca_wiki_model', genModel); }, [genModel]);
  // Intentionally avoid writing api keys to localStorage (CI CodeQL flags clear-text storage)
  useEffect(() => { localStorage.setItem('ca_wiki_base_url', genBaseUrl); }, [genBaseUrl]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { /* keep apiKey in memory only */ }, []);

  // Q&A State
  const [queryInput, setQueryInput] = useState('');
  const [isQuerying, setIsQuerying] = useState(false);
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant'; text: string; citations?: string[] }>>([]);

  // Fetch Tree
  const fetchTree = useCallback(async (project: string) => {
    if (!project) return;
    setLoadingTree(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/wiki/${encodeURIComponent(project)}/tree`, { headers });
      if (!resp.ok) {
        if (resp.status === 404) {
          setTree(null);
          return;
        }
        throw new Error(`Failed to fetch wiki tree: ${resp.statusText}`);
      }
      const data: WikiTreeResponse = await resp.json();
      setTree(data);
      if (data.root && data.root.length > 0 && !selectedPath) {
        setSelectedPath(data.root[0].path);
      }
    } catch (err: unknown) {
      console.error('Error fetching wiki tree:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingTree(false);
    }
  }, [selectedPath]);

  // Fetch Page
  const fetchPage = useCallback(async (project: string, path: string) => {
    if (!project || !path) return;
    setLoadingPage(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/wiki/${encodeURIComponent(project)}/page?path=${encodeURIComponent(path)}`, { headers });
      if (!resp.ok) {
        if (resp.status === 404) {
          setPage(null);
          return;
        }
        throw new Error(`Failed to fetch page: ${resp.statusText}`);
      }
      const data: WikiPage = await resp.json();
      setPage(data);
    } catch (err: unknown) {
      console.error('Error fetching wiki page:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingPage(false);
    }
  }, []);

  useEffect(() => {
    if (currentProject) {
      fetchTree(currentProject);
    }
  }, [currentProject, fetchTree]);

  useEffect(() => {
    if (currentProject && selectedPath) {
      fetchPage(currentProject, selectedPath);
    }
  }, [currentProject, selectedPath, fetchPage]);

  // Handle Wiki Generation
  const handleGenerateWiki = async () => {
    if (!currentProject) return;
    setIsGenerating(true);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const payload: Record<string, unknown> = {
        provider: genProvider,
      };

      if (genBaseUrl.trim()) payload.baseUrl = genBaseUrl.trim();
      if (genModel && genModel !== 'default') payload.model = genModel;
      if (genApiKey) payload.apiKey = genApiKey;

      const resp = await fetch(`${API_BASE}/api/wiki/${encodeURIComponent(currentProject)}/generate`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(errData.error || 'Failed to generate wiki');
      }

      setShowGenModal(false);
      await fetchTree(currentProject);
      setSelectedPath('/overview');
    } catch (err: unknown) {
      console.error('Wiki generation failed:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGenerating(false);
    }
  };

  // Handle Q&A
  const handleAskWiki = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!queryInput.trim() || isQuerying || !currentProject) return;

    const userText = queryInput.trim();
    setChatHistory(prev => [...prev, { role: 'user', text: userText }]);
    setQueryInput('');
    setIsQuerying(true);

    try {
      const headers = await getAuthHeaders();
      const payload: Record<string, unknown> = {
        query: userText,
        provider: genProvider
      };
      if (genBaseUrl.trim()) payload.baseUrl = genBaseUrl.trim();
      if (genModel && genModel !== 'default') payload.model = genModel;
      if (genApiKey) payload.apiKey = genApiKey;

      const resp = await fetch(`${API_BASE}/api/wiki/${encodeURIComponent(currentProject)}/query`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        throw new Error('Failed to query wiki');
      }

      const data = await resp.json();
      setChatHistory(prev => [
        ...prev,
        {
          role: 'assistant',
          text: data.answer || 'No answer generated.',
          citations: data.sources || data.citations || []
        }
      ]);
    } catch (err: unknown) {
      setChatHistory(prev => [
        ...prev,
        { role: 'assistant', text: `Error: ${err instanceof Error ? err.message : String(err)}` }
      ]);
    } finally {
      setIsQuerying(false);
    }
  };

  // Recursive Tree Node Renderer
  const renderTreeNode = (node: WikiNode, depth = 0) => {
    const isSelected = selectedPath === node.path;
    const hasChildren = node.children && node.children.length > 0;

    return (
      <div key={node.path} style={{ marginLeft: depth > 0 ? `${depth * 12}px` : '0px' }}>
        <button
          onClick={() => setSelectedPath(node.path)}
          className={FOCUS_RING_CLASS}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            borderRadius: '6px',
            border: 'none',
            background: isSelected ? 'rgba(0, 240, 255, 0.15)' : 'transparent',
            color: isSelected ? 'var(--primary-neon)' : 'var(--text-muted)',
            cursor: 'pointer',
            textAlign: 'left',
            fontSize: '0.875rem',
            fontWeight: isSelected ? 600 : 400,
            transition: 'all 0.2s ease',
          }}
        >
          {hasChildren ? (
            <Folder size={15} color={isSelected ? 'var(--primary-neon)' : '#8892b0'} />
          ) : (
            <FileText size={15} color={isSelected ? 'var(--primary-neon)' : '#8892b0'} />
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {node.title}
          </span>
        </button>
        {hasChildren && (
          <div style={{ marginTop: '2px' }}>
            {node.children!.map(child => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // Simple Markdown & Code Segment Parser
  const renderMarkdownContent = (content: string) => {
    if (!content) return <div style={{ color: 'var(--text-muted)' }}>No content available.</div>;

    // Split content by markdown code blocks (```lang ... ```)
    const parts = content.split(/(```[\s\S]*?```)/g);

    return (
      <div style={{ lineHeight: '1.7', color: 'var(--text-main)', fontSize: '0.95rem' }}>
        {parts.map((part, index) => {
          if (part.startsWith('```')) {
            const match = part.match(/^```(\w+)?\n([\s\S]*?)```$/);
            const lang = match ? match[1] || '' : '';
            const code = match ? match[2] : part.slice(3, -3);

            if (lang === 'mermaid') {
              return (
                <div
                  key={index}
                  style={{
                    margin: '1.5rem 0',
                    padding: '1.25rem',
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid rgba(0, 240, 255, 0.3)',
                    borderRadius: '8px',
                    position: 'relative'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px', color: 'var(--primary-neon)', fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase' }}>
                    <Layers size={14} /> Mermaid Architecture Diagram
                  </div>
                  <pre style={{ margin: 0, overflowX: 'auto', color: '#00F0FF', fontFamily: 'monospace', fontSize: '0.85rem' }}>
                    {code}
                  </pre>
                </div>
              );
            }

            return (
              <div
                key={index}
                style={{
                  margin: '1.5rem 0',
                  padding: '1.25rem',
                  background: 'rgba(0, 0, 0, 0.5)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '8px',
                  overflowX: 'auto'
                }}
              >
                {lang && (
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '6px', textTransform: 'uppercase' }}>
                    {lang}
                  </div>
                )}
                <pre style={{ margin: 0, fontFamily: 'monospace', color: '#e2e8f0', fontSize: '0.85rem' }}>
                  {code}
                </pre>
              </div>
            );
          }

          // Render regular text paragraphs/headers
          return (
            <div key={index} style={{ margin: '1rem 0' }}>
              {part.split('\n\n').map((paragraph, pIdx) => {
                if (paragraph.startsWith('# ')) {
                  return (
                    <h1 key={pIdx} className="tech-font" style={{ fontSize: '1.8rem', color: '#fff', margin: '1.5rem 0 1rem 0', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '0.5rem' }}>
                      {paragraph.replace('# ', '')}
                    </h1>
                  );
                }
                if (paragraph.startsWith('## ')) {
                  return (
                    <h2 key={pIdx} className="tech-font" style={{ fontSize: '1.4rem', color: 'var(--primary-neon)', margin: '1.25rem 0 0.75rem 0' }}>
                      {paragraph.replace('## ', '')}
                    </h2>
                  );
                }
                if (paragraph.startsWith('### ')) {
                  return (
                    <h3 key={pIdx} style={{ fontSize: '1.1rem', color: '#fff', margin: '1rem 0 0.5rem 0' }}>
                      {paragraph.replace('### ', '')}
                    </h3>
                  );
                }
                if (paragraph.startsWith('- ')) {
                  return (
                    <ul key={pIdx} style={{ paddingLeft: '1.5rem', margin: '0.5rem 0' }}>
                      {paragraph.split('\n').map((item, iIdx) => (
                        <li key={iIdx} style={{ margin: '0.25rem 0' }}>{item.replace(/^- /, '')}</li>
                      ))}
                    </ul>
                  );
                }
                return (
                  <p key={pIdx} style={{ margin: '0.75rem 0' }}>
                    {paragraph}
                  </p>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', height: '100%', minHeight: '800px' }}>

      {/* Top Controls Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        paddingBottom: '1.5rem',
        flexWrap: 'wrap',
        gap: '1rem'
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <span style={{
              background: 'rgba(0, 240, 255, 0.12)',
              color: 'var(--primary-neon)',
              fontSize: '0.75rem',
              fontWeight: 800,
              padding: '0.25rem 0.75rem',
              borderRadius: '20px',
              border: '1px solid rgba(0, 240, 255, 0.2)',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}>
              <BookOpen size={12} /> DeepWiki Intelligence
            </span>
          </div>
          <h1 className="tech-font" style={{ fontSize: '2rem', fontWeight: 900, color: '#fff', margin: 0 }}>
            Project Knowledge Wiki
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
            Automated architecture, component deep-dives, and AI-assisted conversational search.
          </p>
        </div>

        {/* Project Selector & Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {projects.length > 0 && (
            <select
              value={selectedProjectDir || ''}
              onChange={(e) => {
                const dir = e.target.value;
                if (onProjectChange) onProjectChange(dir);
                const match = projects.find(p => p.dir === dir);
                if (match) setCurrentProject(match.name);
              }}
              className={FOCUS_RING_CLASS}
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '8px',
                padding: '0.6rem 1rem',
                color: '#fff',
                fontSize: '0.9rem',
                outline: 'none',
                cursor: 'pointer'
              }}
            >
              {projects.map(p => (
                <option key={p.dir} value={p.dir} style={{ background: '#111', color: '#fff' }}>
                  {p.name}
                </option>
              ))}
            </select>
          )}

          <button
            onClick={() => setShowGenModal(true)}
            className={`btn-neon-cyan ${FOCUS_RING_CLASS}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '0.6rem 1.25rem',
              fontSize: '0.9rem',
              borderRadius: '8px'
            }}
          >
            <Sparkles size={16} /> Rebuild Wiki
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          padding: '1rem',
          background: 'rgba(255, 75, 75, 0.1)',
          border: '1px solid rgba(255, 75, 75, 0.3)',
          borderRadius: '8px',
          color: '#FFB4AB',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {/* Main Grid View */}
      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr 340px', gap: '1.5rem', flex: 1, minHeight: '650px' }}>

        {/* Left Sidebar: Tree Navigation */}
        <div style={{
          background: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '12px',
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
          overflowY: 'auto'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Pages Tree
            </span>
            <button
              onClick={() => fetchTree(currentProject)}
              disabled={loadingTree}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
            >
              <RefreshCw size={14} className={loadingTree ? 'animate-spin' : ''} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loadingTree ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', padding: '1rem' }}>
                <Loader2 size={16} className="animate-spin" /> Loading hierarchy...
              </div>
            ) : tree && tree.root && tree.root.length > 0 ? (
              tree.root.map(node => renderTreeNode(node))
            ) : (
              <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                No wiki pages found. Click "Rebuild Wiki" to generate documentation!
              </div>
            )}
          </div>
        </div>

        {/* Center: Main Markdown Reader */}
        <div style={{
          background: 'rgba(255, 255, 255, 0.03)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '12px',
          padding: '2rem',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column'
        }}>
          {loadingPage ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '8px', color: 'var(--primary-neon)' }}>
              <Loader2 size={24} className="animate-spin" /> Loading document...
            </div>
          ) : page ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '0.5rem', color: 'var(--primary-neon)', fontSize: '0.85rem' }}>
                <FileText size={16} /> {page.path}
              </div>
              <h1 className="tech-font" style={{ fontSize: '2rem', color: '#fff', margin: '0 0 1rem 0' }}>
                {page.title}
              </h1>
              {page.summary && (
                <div style={{
                  padding: '1rem',
                  background: 'rgba(0, 240, 255, 0.05)',
                  borderLeft: '4px solid var(--primary-neon)',
                  borderRadius: '0 8px 8px 0',
                  color: 'var(--text-muted)',
                  fontSize: '0.9rem',
                  marginBottom: '1.5rem'
                }}>
                  {page.summary}
                </div>
              )}
              {renderMarkdownContent(page.content)}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', textAlign: 'center' }}>
              <BookOpen size={48} style={{ opacity: 0.2, marginBottom: '1rem' }} />
              <p>Select a wiki page from the sidebar, or generate wiki documentation for this project.</p>
            </div>
          )}
        </div>

        {/* Right Sidebar: Wiki Interactive Q&A Drawer */}
        <div style={{
          background: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '12px',
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '0.75rem' }}>
            <Bot size={18} color="var(--primary-neon)" />
            <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fff' }}>
              Ask Wiki Assistant
            </span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem', paddingRight: '4px' }}>
            {chatHistory.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', marginTop: '2rem' }}>
                Ask anything about the architecture, services, or endpoints in <strong>{currentProject}</strong>.
              </div>
            ) : (
              chatHistory.map((msg, i) => (
                <div
                  key={i}
                  style={{
                    alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '90%',
                    background: msg.role === 'user' ? 'rgba(0, 240, 255, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                    border: msg.role === 'user' ? '1px solid rgba(0, 240, 255, 0.3)' : '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '8px',
                    padding: '0.75rem 1rem',
                    fontSize: '0.85rem',
                    color: '#fff'
                  }}
                >
                  <div>{msg.text}</div>
                  {msg.citations && msg.citations.length > 0 && (
                    <div style={{ marginTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '0.4rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      <strong>Sources:</strong> {msg.citations.join(', ')}
                    </div>
                  )}
                </div>
              ))
            )}
            {isQuerying && (
              <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--primary-neon)', fontSize: '0.85rem', padding: '0.5rem' }}>
                <Loader2 size={14} className="animate-spin" /> Synthesizing answer...
              </div>
            )}
          </div>

          <form onSubmit={handleAskWiki} style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder="Ask a question..."
              className={FOCUS_RING_CLASS}
              style={{
                flex: 1,
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '6px',
                padding: '0.6rem 0.75rem',
                color: '#fff',
                fontSize: '0.85rem',
                outline: 'none'
              }}
            />
            <button
              type="submit"
              disabled={isQuerying || !queryInput.trim()}
              className={FOCUS_RING_CLASS}
              style={{
                background: 'var(--primary-neon)',
                color: '#000',
                border: 'none',
                borderRadius: '6px',
                padding: '0.6rem 0.75rem',
                cursor: 'pointer',
                opacity: isQuerying || !queryInput.trim() ? 0.5 : 1
              }}
            >
              <Send size={16} />
            </button>
          </form>
        </div>

      </div>

      {/* Generation Provider Dialog Modal */}
      <AnimatePresence>
        {showGenModal && (
          <div style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(5px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100
          }}>
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              style={{
                background: '#0D1117',
                border: '1px solid rgba(0, 240, 255, 0.3)',
                borderRadius: '16px',
                padding: '2rem',
                width: '450px',
                maxWidth: '90vw',
                display: 'flex',
                flexDirection: 'column',
                gap: '1.25rem'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Settings size={20} color="var(--primary-neon)" />
                <h2 className="tech-font" style={{ fontSize: '1.25rem', color: '#fff', margin: 0 }}>
                  LLM Settings & Generation for {currentProject}
                </h2>
              </div>

              <div style={{ padding: '0.85rem', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)' }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                  Load Saved Preset
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <select
                    aria-label="Load Saved Preset"
                    value={activeProfileId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setActiveProfileId(id);
                      const p = profiles.find(x => x.id === id);
                      if (p) {
                        setGenProvider(p.provider);
                        setGenModel(p.model);
                        setGenApiKey(p.apiKey);
                        setGenBaseUrl(p.baseUrl);
                      }
                    }}
                    className={FOCUS_RING_CLASS}
                    style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '6px', padding: '0.5rem', color: '#fff', outline: 'none' }}
                  >
                    <option value="" style={{ background: '#111' }}>-- Custom / Temporary Config --</option>
                    {profiles.map(p => <option key={p.id} value={p.id} style={{ background: '#111' }}>{p.name}</option>)}
                  </select>
                  {activeProfileId && (
                    <button
                      onClick={() => {
                        setProfiles(prev => prev.filter(x => x.id !== activeProfileId));
                        setActiveProfileId('');
                      }}
                      style={{ background: 'rgba(255, 75, 75, 0.1)', color: '#FFB4AB', border: '1px solid rgba(255, 75, 75, 0.3)', borderRadius: '6px', padding: '0.5rem', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                      title="Delete selected preset"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>

              <div>
                <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                  LLM Provider
                </label>
                <select
                  aria-label="LLM Provider"
                  value={genProvider}
                  onChange={(e) => setGenProvider(e.target.value)}
                  className={FOCUS_RING_CLASS}
                  style={{
                    width: '100%',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: '8px',
                    padding: '0.6rem',
                    color: '#fff',
                    outline: 'none'
                  }}
                >
                  <option value="mock" style={{ background: '#111' }}>Offline AST & Template Fallback (No API Key)</option>
                  <option value="anthropic" style={{ background: '#111' }}>Anthropic Claude</option>
                  <option value="openai" style={{ background: '#111' }}>OpenAI</option>
                  <option value="openai-compatible" style={{ background: '#111' }}>Custom / Local (Ollama, vLLM, DeepSeek)</option>
                </select>
              </div>

              {genProvider !== 'mock' && (
                <>
                  <div>
                    <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                      Model Name
                    </label>
                    <input
                      type="text"
                      value={genModel}
                      onChange={(e) => setGenModel(e.target.value)}
                      placeholder="e.g. claude-3-7-sonnet-20250219 or gpt-4o"
                      className={FOCUS_RING_CLASS}
                      style={{
                        width: '100%',
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: '8px',
                        padding: '0.6rem',
                        color: '#fff',
                        outline: 'none'
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                      API Key (Optional if already configured)
                    </label>
                    <input
                      type="password"
                      value={genApiKey}
                      onChange={(e) => setGenApiKey(e.target.value)}
                      placeholder="sk-..."
                      className={FOCUS_RING_CLASS}
                      style={{
                        width: '100%',
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: '8px',
                        padding: '0.6rem',
                        color: '#fff',
                        outline: 'none'
                      }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                      Custom API Endpoint (Base URL)
                    </label>
                    <input
                      type="text"
                      value={genBaseUrl}
                      onChange={(e) => setGenBaseUrl(e.target.value)}
                      placeholder="e.g. http://127.0.0.1:11434/v1/chat/completions"
                      className={FOCUS_RING_CLASS}
                      style={{
                        width: '100%',
                        background: 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: '8px',
                        padding: '0.6rem',
                        color: '#fff',
                        outline: 'none'
                      }}
                    />
                  </div>
                </>
              )}

              
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginTop: '0.5rem', paddingTop: '1.25rem', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                {/* Save Preset Section */}
                <div>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: '6px' }}>
                    Save Current Config as Preset
                  </label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="text"
                      value={profileNameInput}
                      onChange={e => setProfileNameInput(e.target.value)}
                      placeholder="e.g. My Claude Sub"
                      className={FOCUS_RING_CLASS}
                      style={{ 
                        flex: 1, 
                        background: 'rgba(255,255,255,0.05)', 
                        border: '1px solid rgba(255,255,255,0.15)', 
                        borderRadius: '6px', 
                        padding: '0.6rem 0.75rem', 
                        color: '#fff', 
                        outline: 'none', 
                        fontSize: '0.85rem' 
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (!profileNameInput.trim()) return;
                        const newId = Date.now().toString();
                        setProfiles(prev => [...prev, {
                          id: newId,
                          name: profileNameInput.trim(),
                          provider: genProvider,
                          model: genModel,
                          apiKey: genApiKey,
                          baseUrl: genBaseUrl,
                        }]);
                        setActiveProfileId(newId);
                        setProfileNameInput('');
                      }}
                      disabled={!profileNameInput.trim()}
                      style={{ 
                        background: 'rgba(0, 240, 255, 0.1)', 
                        color: 'var(--primary-neon)', 
                        border: '1px solid rgba(0, 240, 255, 0.3)', 
                        borderRadius: '6px', 
                        padding: '0.6rem 1rem', 
                        cursor: 'pointer', 
                        fontSize: '0.85rem', 
                        fontWeight: 600, 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '6px', 
                        opacity: !profileNameInput.trim() ? 0.3 : 1 
                      }}
                    >
                      <Save size={16} /> Save
                    </button>
                  </div>
                </div>

                {/* Primary Actions */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', marginTop: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => setShowGenModal(false)}
                    style={{ 
                      background: 'rgba(255,255,255,0.05)', 
                      border: '1px solid rgba(255,255,255,0.1)', 
                      borderRadius: '8px', 
                      padding: '0.75rem 1.25rem', 
                      color: '#fff', 
                      cursor: 'pointer',
                      fontSize: '0.9rem',
                      fontWeight: 500
                    }}
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerateWiki}
                    disabled={isGenerating}
                    className={`btn-neon-cyan ${FOCUS_RING_CLASS}`}
                    style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '8px', 
                      borderRadius: '8px', 
                      padding: '0.75rem 1.25rem',
                      fontSize: '0.9rem',
                      fontWeight: 600
                    }}
                  >
                    {isGenerating ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
                    {isGenerating ? 'Building...' : 'Generate Wiki'}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>

        )}
      </AnimatePresence>

    </div>
  );
};
