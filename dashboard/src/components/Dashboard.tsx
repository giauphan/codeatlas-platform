import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { db } from '../lib/firebase';
import { 
  collection, 
  addDoc, 
  deleteDoc, 
  doc, 
  onSnapshot, 
  query, 
  orderBy,
  serverTimestamp 
} from 'firebase/firestore';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  LogOut, 
  Globe, 
  Network, 
  Brain,
  ShieldCheck, 
  LayoutDashboard,
  BookOpen,
  Lightbulb
} from 'lucide-react';

// Decoupled sub-views
import { ControlCenterView } from './ControlCenterView';
import { KnowledgeGraphView } from './KnowledgeGraphView';
import { SphericalKnowledgeGraph } from './KnowledgeNetwork3D';
import { CloudIndexView } from './CloudIndexView';
import { DreamMemoryView } from './DreamMemoryView';
import { SecondBrainView } from './SecondBrainView';
import { DocumentationView } from './DocumentationView';
import { safeSessionStorageSetItem, safeSessionStorageGetItem, safeSessionStorageRemoveItem } from '../lib/safeSessionStorage';
import { getAuthHeaders } from '../lib/auth';

// API Configuration
const API_BASE = window.location.origin.includes('localhost:5173')
  ? 'http://localhost:8080'
  : window.location.origin;

interface ApiKey {
  id: string;
  name: string;
  key: string;
  tier: string;
  createdAt: any;
}

interface AnalysisData {
  analysis?: AnalysisData; // Support nested analysis response
  stats?: {
    totalFiles?: number;
    totalModules?: number;
    totalClasses?: number;
    totalFunctions?: number;
    totalVariables?: number;
    loc?: number;
  };
  entityCounts?: {
    modules?: number;
    functions?: number;
    classes?: number;
    variables?: number;
    dependencies?: number;
    circularDeps?: number;
    deadCode?: number;
  };
  totalFilesAnalyzed?: number;
  graph: {
    nodes: any[];
    links: any[];
  };
}

const memoryAnalysisCache = new Map<string, AnalysisData>();

const getDefaultProjectWithDir = (data: { name: string; dir: string }[], savedDir: string) => {
  // Prefer saved directory from session, fallback to first project
  if (savedDir && data.some(p => p.dir === savedDir)) return savedDir;
  return data.length > 0 ? data[0].dir : '';
};

export const Dashboard: React.FC = () => {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [keysLoading, setKeysLoading] = useState(true);
  const loading = projectsLoading || keysLoading;
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('Control Center');
  const [analysis, setAnalysis] = useState<AnalysisData | null>(() => {
    const savedProjDir = safeSessionStorageGetItem('ca_selected_project_dir');
    if (savedProjDir) {
      const cachedProject = safeSessionStorageGetItem(`ca_analysis_cache_${savedProjDir}`);
      if (cachedProject) {
        try {
          const parsed = JSON.parse(cachedProject);
          memoryAnalysisCache.set(savedProjDir, parsed);
          return parsed;
        } catch (e) {
          safeSessionStorageRemoveItem(`ca_analysis_cache_${savedProjDir}`);
        }
      }
    }
    const cached = safeSessionStorageGetItem('ca_analysis_cache');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        memoryAnalysisCache.set('', parsed);
        return parsed;
      } catch (e) {
        safeSessionStorageRemoveItem('ca_analysis_cache');
      }
    }
    return null;
  });
  const [selectedProjectDir, setSelectedProjectDir] = useState<string>(() => {
    return safeSessionStorageGetItem('ca_selected_project_dir') || '';
  });
  const [isIndexingEnabled, setIsIndexingEnabled] = useState<boolean>(() => {
    const savedProjDir = safeSessionStorageGetItem('ca_selected_project_dir');
    if (savedProjDir) {
      const cached = safeSessionStorageGetItem(`codeatlas_indexing_enabled_${savedProjDir}`);
      if (cached !== null) {
        try {
          return JSON.parse(cached);
        } catch {
          // ignore
        }
      }
    }
    return true;
  });
  const [isUpdatingSettings, setIsUpdatingSettings] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [stats, setStats] = useState({ totalRequests: 0 });

  const fetchIndexingSettings = async (projectDir: string) => {
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/projects/settings?projectDir=${encodeURIComponent(projectDir)}`, { headers });
      if (resp.ok) {
        const data = await resp.json();
        setIsIndexingEnabled(data.indexingEnabled);
        safeSessionStorageSetItem(`codeatlas_indexing_enabled_${projectDir}`, JSON.stringify(data.indexingEnabled));
      }
    } catch (err) {
      console.error("Failed to fetch indexing settings:", err);
    }
  };

  useEffect(() => {
    if (selectedProjectDir) {
      const cached = safeSessionStorageGetItem(`codeatlas_indexing_enabled_${selectedProjectDir}`);
      if (cached !== null) {
        try {
          setIsIndexingEnabled(JSON.parse(cached));
        } catch {
          // ignore
        }
      }
      fetchIndexingSettings(selectedProjectDir);
    }
  }, [selectedProjectDir]);

  const handleToggleIndexingEnabled = useCallback(async (newValue: boolean) => {
    if (!selectedProjectDir || isUpdatingSettings) return;
    
    const oldValue = isIndexingEnabled;
    setIsIndexingEnabled(newValue);
    safeSessionStorageSetItem(`codeatlas_indexing_enabled_${selectedProjectDir}`, JSON.stringify(newValue));
    setIsUpdatingSettings(true);
    
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/projects/settings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          projectDir: selectedProjectDir,
          indexingEnabled: newValue
        })
      });
      if (!resp.ok) {
        let errMsg = "Server error";
        try {
          const data = await resp.json();
          errMsg = data.error || errMsg;
        } catch {
          // ignore
        }
        throw new Error(errMsg);
      }
    } catch (err) {
      console.error("Failed to update indexing settings:", err);
      setIsIndexingEnabled(oldValue);
      safeSessionStorageSetItem(`codeatlas_indexing_enabled_${selectedProjectDir}`, JSON.stringify(oldValue));
      alert(`Failed to update indexing settings: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsUpdatingSettings(false);
    }
  }, [selectedProjectDir, isIndexingEnabled, isUpdatingSettings]);

  const [projects, setProjects] = useState<{ name: string; dir: string }[]>(() => {
    // Restore project list from session cache on mount
    try {
      const cached = safeSessionStorageGetItem('ca_projects_cache');
      if (cached) return JSON.parse(cached);
    } catch {
      safeSessionStorageRemoveItem('ca_projects_cache');
    }
    return [];
  });
  // Restore user from session
  const [user, setUser] = useState<any>(() => {
    const savedApiKey = safeSessionStorageGetItem('ca_api_key');
    const email = safeSessionStorageGetItem('ca_user_email');
    if (savedApiKey) {
      return {
        uid: email || 'api-key-session',
        email: email || 'user@codeatlas.local'
      };
    }
    return null;
  });

  const clearAllCaches = () => {
    setProjects([]);
    setSelectedProjectDir('');
    setAnalysis(null);
    memoryAnalysisCache.clear();
    safeSessionStorageRemoveItem('ca_selected_project_dir');
    safeSessionStorageRemoveItem('ca_analysis_cache');
    try {
      Object.keys(sessionStorage).forEach(k => {
        if (k.startsWith('ca_analysis_cache_') || k.startsWith('codeatlas_indexing_enabled_')) {
          safeSessionStorageRemoveItem(k);
        }
      });
    } catch {
      // sessionStorage not available — skip
    }
    safeSessionStorageRemoveItem('ca_projects_cache');
  };

  const fetchAnalysis = async (projectDir?: string, forceRefresh = false) => {
    const cacheKey = projectDir || '';
    if (cacheKey && !forceRefresh && memoryAnalysisCache.has(cacheKey)) {
      setAnalysis(memoryAnalysisCache.get(cacheKey)!);
      return;
    }

    try {
      const url = projectDir 
        ? `${API_BASE}/api/analysis?projectDir=${encodeURIComponent(projectDir)}`
        : `${API_BASE}/api/analysis`;
      const headers = await getAuthHeaders();
      const resp = await fetch(url, { headers });
      if (resp.ok) {
        const data = await resp.json();
        if (data.error) {
          console.warn(`[Dashboard] Analysis API returned error: ${data.error}`);
          setAnalysis(null);
          memoryAnalysisCache.set(cacheKey, null);
        } else {
          setAnalysis(data);
          memoryAnalysisCache.set(cacheKey, data);
          if (projectDir) {
            safeSessionStorageSetItem(`ca_analysis_cache_${projectDir}`, JSON.stringify(data));
          } else {
            safeSessionStorageSetItem('ca_analysis_cache', JSON.stringify(data));
          }
        }
      } else {
        // Clear cached stale data if backend rejects access (404/403 boundary violation)
        setAnalysis(null);
        memoryAnalysisCache.delete(cacheKey);
        if (projectDir) {
          safeSessionStorageRemoveItem(`ca_analysis_cache_${projectDir}`);
        }
        safeSessionStorageRemoveItem('ca_analysis_cache');

        // Gracefully handle 404/failure: clear state, don't retry (prevents infinite loop)
        if (resp.status === 404 && projectDir) {
          setSelectedProjectDir('');
          safeSessionStorageRemoveItem('ca_selected_project_dir');
        }
      }
    } catch (err) {
      console.error("Failed to fetch analysis:", err);
      setAnalysis(null);
      memoryAnalysisCache.delete(cacheKey);
      safeSessionStorageRemoveItem(`ca_analysis_cache_${projectDir}`);
      safeSessionStorageRemoveItem('ca_analysis_cache');
    }
  };

  const fetchProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/projects`, { headers });
      if (resp.ok) {
        const data = await resp.json();
        setProjects(data);
        safeSessionStorageSetItem('ca_projects_cache', JSON.stringify(data));

        if (data.length > 0) {
          const hasSelected = selectedProjectDir && data.some((p: { name: string; dir: string }) => p.dir === selectedProjectDir);
          if (!hasSelected) {
            // No project selected or selected project no longer exists — pick default and fetch fresh data
            const defaultDir = data[0].dir;
            setSelectedProjectDir(defaultDir);
            safeSessionStorageSetItem('ca_selected_project_dir', defaultDir);
            fetchAnalysis(defaultDir);
          } else {
            // Selected project exists, fetch its analysis
            fetchAnalysis(selectedProjectDir);
          }
        } else {
          // No projects found, clear selection and analysis
          setSelectedProjectDir('');
          safeSessionStorageRemoveItem('ca_selected_project_dir');
          setAnalysis(null);
        }
      } else {
        setProjects([]);
        safeSessionStorageRemoveItem('ca_projects_cache');
        setSelectedProjectDir('');
        safeSessionStorageRemoveItem('ca_selected_project_dir');
        setAnalysis(null);
      }
    } catch (err) {
      console.error("Failed to fetch projects:", err);
      setProjects([]);
      setAnalysis(null);
    } finally {
      setProjectsLoading(false);
    }
  }, [selectedProjectDir]);

  const fetchApiKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/keys`, { headers });
      if (!resp.ok) {
        let errMsg = "Server error";
        try {
          const data = await resp.json();
          errMsg = data.error || errMsg;
        } catch {
          // ignore
        }
        throw new Error(errMsg);
      }
      const data = await resp.json();
      setKeys(data);
    } catch (err) {
      console.error("Failed to fetch API keys:", err);
    } finally {
      setKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
    fetchApiKeys();
  }, [fetchProjects, fetchApiKeys]);

  const handleProjectChange = (dir: string) => {
    setSelectedProjectDir(dir);
    safeSessionStorageSetItem('ca_selected_project_dir', dir);
    fetchAnalysis(dir);
  };

  const handleReindex = async () => {
    if (!selectedProjectDir) return;
    setIsIndexing(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/reindex`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectDir: selectedProjectDir })
      });
      if (!resp.ok) {
        throw new Error("Reindex failed");
      }
      await fetchAnalysis(selectedProjectDir, true);
    } catch (err) {
      console.error("Reindex error:", err);
      alert(`Reindex failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsIndexing(false);
    }
  };

  const handleCreateApiKey = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setKeysLoading(true);
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/keys`, {
        method: 'POST',
        headers
      });
      if (!resp.ok) {
        let errMsg = "Server error";
        try {
          const data = await resp.json();
          errMsg = data.error || errMsg;
        } catch {
          // ignore
        }
        throw new Error(errMsg);
      }
      const newKey = await resp.json();
      alert(`New API Key created: ${newKey.key}. Please save it in a safe place!`);
    } catch (err) {
      console.error("Failed to create API key:", err);
      alert(`Failed to create API key: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setKeysLoading(false);
    }
  };

  const handleDeleteApiKey = async (keyId: string) => {
    if (!window.confirm('Are you sure you want to delete this API Key?')) {
      return;
    }
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/keys/${keyId}`, {
        method: 'DELETE',
        headers
      });
      if (!resp.ok) {
        let errMsg = "Server error";
        try {
          const data = await resp.json();
          errMsg = data.error || errMsg;
        } catch {
          // ignore
        }
        throw new Error(errMsg);
      }
      fetchApiKeys(); // Refresh the list
    } catch (err) {
      console.error("Failed to delete API key:", err);
      alert(`Failed to delete API key: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCopyClick = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(text);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const renderCurrentView = () => {
    switch (activeTab) {
      case 'Control Center':
        return <ControlCenterView
          stats={stats}
          keys={keys}
          analysis={analysis}
          createKey={handleCreateApiKey}
          deleteKey={handleDeleteApiKey}
          copyToClipboard={handleCopyClick}
          copiedId={copiedId}
          loading={loading}
        />;
      case 'Knowledge Graph':
        return <KnowledgeGraphView
          projects={projects}
          selectedProjectDir={selectedProjectDir}
          onProjectChange={handleProjectChange}
          onDeleteProject={async () => {
            alert("Project deletion not implemented in this PR");
          }}
          analysis={analysis}
        />;
      case 'Cloud Index':
        return <CloudIndexView 
          analysis={analysis}
          isIndexing={isIndexing}
          onReindex={handleReindex}
          isIndexingEnabled={isIndexingEnabled}
          setIsIndexingEnabled={(v: boolean) => handleToggleIndexingEnabled(v)}
          isUpdatingSettings={isUpdatingSettings}
        />;
      case 'Dream Memories':
        return <DreamMemoryView />;
      case 'Second Brain':
        return <SecondBrainView />;
      case 'Documentation':
        return <DocumentationView />;
      default:
        return <ControlCenterView
          stats={stats}
          keys={keys}
          analysis={analysis}
          createKey={handleCreateApiKey}
          deleteKey={handleDeleteApiKey}
          copyToClipboard={handleCopyClick}
          copiedId={copiedId}
          loading={loading}
        />;
    }
  };

  return (
    <div style={{
      display: 'flex', minHeight: '100vh', background: 'var(--background-dark)', color: '#fff',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif'
    }}>
      {/* Sidebar Navigation */}
      <nav style={{
        width: '240px', background: 'var(--background-light)', padding: '2rem 1.5rem',
        display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-color)'
      }}>
        <div style={{ flexGrow: 1 }}>
          <h1 className="tech-font" style={{
            fontSize: '1.5rem', letterSpacing: '0.1em', marginBottom: '3rem',
            display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--primary-neon)'
          }}>
            CODEATLAS <ShieldCheck size={20} />
          </h1>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {['Control Center', 'Knowledge Graph', 'Cloud Index', 'Dream Memories', 'Second Brain', 'Documentation'].map(tab => (
              <li key={tab} style={{ marginBottom: '1rem' }}>
                <button
                  onClick={() => setActiveTab(tab)}
                  style={{
                    width: '100%', padding: '0.75rem 1rem', borderRadius: '8px',
                    background: activeTab === tab ? 'var(--button-active-background)' : 'transparent',
                    color: activeTab === tab ? 'var(--primary-neon)' : 'var(--text-muted)',
                    border: 'none', textAlign: 'left', cursor: 'pointer',
                    fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem',
                    transition: 'all 0.3s ease',
                    boxShadow: activeTab === tab ? '0 0 15px rgba(0, 240, 255, 0.2)' : 'none'
                  }}
                >
                  {tab === 'Control Center' && <LayoutDashboard size={18} />}
                  {tab === 'Knowledge Graph' && <Network size={18} />}
                  {tab === 'Cloud Index' && <Globe size={18} />}
                  {tab === 'Dream Memories' && <Brain size={18} />}
                  {tab === 'Second Brain' && <Lightbulb size={18} />}
                  {tab === 'Documentation' && <BookOpen size={18} />}
                  {tab}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* User / Logout */}
        <div style={{ marginTop: '3rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color-light)' }}>
          {user && (
            <div style={{ marginBottom: '1rem', fontSize: '0.9rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontWeight: 600, color: '#fff' }}>{user.email || 'API User'}</span>
            </div>
          )}
          <button
            onClick={clearAllCaches}
            style={{
              width: '100%', padding: '0.75rem 1rem', borderRadius: '8px',
              background: 'transparent', color: 'var(--text-muted)',
              border: 'none', textAlign: 'left', cursor: 'pointer',
              fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem',
              transition: 'all 0.3s ease'
            }}
          >
            <LogOut size={18} /> Logout
          </button>
        </div>
      </nav>

      {/* Main Content Area */}
      <main style={{ flexGrow: 1, padding: '2rem', overflowY: 'auto' }}>
        {renderCurrentView()}
      </main>

      <style>{`
        :root {
          --primary-neon: #00F0FF;
          --secondary-neon: #9D00FF;
          --background: #050505;
          --background-dark: #000;
          --background-light: #0A0A0A;
          --border-color: rgba(255,255,255,0.08);
          --border-color-light: rgba(255,255,255,0.15);
          --text-muted: #888;
          --button-active-background: rgba(0, 240, 255, 0.1);
        }
        .tech-font { font-family: 'Inter', system-ui, sans-serif; }
        .btn-neon-cyan {
          background: linear-gradient(45deg, #00BFFF, #00FFFF);
          color: #000;
          border: none;
          border-radius: 12px;
          padding: 1rem 2rem;
          font-size: 1.1rem;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.3s ease;
          box-shadow: 0 0 20px rgba(0, 240, 255, 0.4);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .btn-neon-cyan:hover:not(:disabled) {
          box-shadow: 0 0 30px rgba(0, 240, 255, 0.6);
          transform: translateY(-2px);
        }
        .btn-neon-cyan:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          box-shadow: none;
        }
      `}</style>
    </div>
  );
};