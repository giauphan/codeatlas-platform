import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { auth, db } from '../lib/firebase';
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

const safeSessionStorageSetItem = (key: string, value: string) => {
  try {
    sessionStorage.setItem(key, value);
  } catch (err: any) {
    const isQuotaError = err && (
      err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err.code === 22 ||
      err.code === 1014
    );
    if (isQuotaError) {
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith('ca_analysis_cache_') && k !== key) {
            keysToRemove.push(k);
          }
        }
        keysToRemove.forEach(k => sessionStorage.removeItem(k));
        
        sessionStorage.setItem(key, value);
      } catch (retryErr) {
        console.info(`[CodeAtlas] Project analysis size (${(value.length / 1024 / 1024).toFixed(2)} MB) exceeds browser sessionStorage quota limit. Operating in high-performance memory-only mode without local cache.`);
      }
    } else {
      console.info("Failed to write to sessionStorage:", err);
    }
  }
};

/** Generation counter to discard stale fetch responses (fixes race condition) */
let fetchGeneration = 0;

const getDefaultProjectWithDir = (data: { name: string; dir: string }[], savedDir: string) => {
  // Prefer saved directory from session, fallback to first project
  if (savedDir && data.some(p => p.dir === savedDir)) return savedDir;
  return data.length > 0 ? data[0].dir : '';
};

export const Dashboard: React.FC = () => {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('Control Center');
  const [analysis, setAnalysis] = useState<AnalysisData | null>(() => {
    const savedProjDir = sessionStorage.getItem('ca_selected_project_dir');
    if (savedProjDir) {
      const cachedProject = sessionStorage.getItem(`ca_analysis_cache_${savedProjDir}`);
      if (cachedProject) {
        try {
          const parsed = JSON.parse(cachedProject);
          memoryAnalysisCache.set(savedProjDir, parsed);
          return parsed;
        } catch (e) {
          sessionStorage.removeItem(`ca_analysis_cache_${savedProjDir}`);
        }
      }
    }
    const cached = sessionStorage.getItem('ca_analysis_cache');
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        memoryAnalysisCache.set('', parsed);
        return parsed;
      } catch (e) {
        sessionStorage.removeItem('ca_analysis_cache');
      }
    }
    return null;
  });
  const [selectedProjectDir, setSelectedProjectDir] = useState<string>(() => {
    return sessionStorage.getItem('ca_selected_project_dir') || '';
  });
  const [isIndexingEnabled, setIsIndexingEnabled] = useState<boolean>(() => {
    const savedProjDir = sessionStorage.getItem('ca_selected_project_dir');
    if (savedProjDir) {
      const cached = sessionStorage.getItem(`codeatlas_indexing_enabled_${savedProjDir}`);
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
      const cached = sessionStorage.getItem(`codeatlas_indexing_enabled_${selectedProjectDir}`);
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

  const [isIndexing, setIsIndexing] = useState(false);
  const [stats, setStats] = useState({ totalRequests: 0 });
  const [projects, setProjects] = useState<{ name: string; dir: string }[]>(() => {
    // Restore project list from session cache on mount
    try {
      const cached = sessionStorage.getItem('ca_projects_cache');
      if (cached) return JSON.parse(cached);
    } catch {
      sessionStorage.removeItem('ca_projects_cache');
    }
    return [];
  });
  const user = auth.currentUser;

  const clearAllCaches = () => {
    setProjects([]);
    setSelectedProjectDir('');
    setAnalysis(null);
    memoryAnalysisCache.clear();
    sessionStorage.removeItem('ca_selected_project_dir');
    sessionStorage.removeItem('ca_analysis_cache');
    Object.keys(sessionStorage).forEach(k => {
      if (k.startsWith('ca_analysis_cache_') || k.startsWith('codeatlas_indexing_enabled_')) {
        sessionStorage.removeItem(k);
      }
    });
    sessionStorage.removeItem('ca_projects_cache');
  };

  const getAuthHeaders = async () => {
    // Check for active token key session first
    const savedApiKey = sessionStorage.getItem('ca_api_key');
    if (savedApiKey) {
      return {
        'x-api-key': savedApiKey,
        'Content-Type': 'application/json'
      };
    }

    const currentUser = auth.currentUser;
    if (currentUser) {
      const token = await currentUser.getIdToken();
      return {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      };
    }
    return {
      'Content-Type': 'application/json'
    };
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
        setAnalysis(data);
        memoryAnalysisCache.set(cacheKey, data);
        if (projectDir) {
          safeSessionStorageSetItem(`ca_analysis_cache_${projectDir}`, JSON.stringify(data));
        } else {
          safeSessionStorageSetItem('ca_analysis_cache', JSON.stringify(data));
        }
      } else {
        // Clear cached stale data if backend rejects access (404/403 boundary violation)
        setAnalysis(null);
        memoryAnalysisCache.delete(cacheKey);
        if (projectDir) {
          sessionStorage.removeItem(`ca_analysis_cache_${projectDir}`);
        }
        sessionStorage.removeItem('ca_analysis_cache');

        // Gracefully handle 404/failure responses by explicitly resetting project selection to trigger re-discovery
        if (resp.status === 404 && projectDir) {
          setSelectedProjectDir('');
          sessionStorage.removeItem('ca_selected_project_dir');
          fetchProjects();
        }
      }
    } catch (err) {
      console.error("Failed to fetch analysis:", err);
      setAnalysis(null);
      memoryAnalysisCache.delete(cacheKey);
      if (projectDir) {
        sessionStorage.removeItem(`ca_analysis_cache_${projectDir}`);
      }
      sessionStorage.removeItem('ca_analysis_cache');
    }
  };

  const fetchProjects = async (forceRefresh = false) => {
    const generation = ++fetchGeneration;
    let cacheApplied = false;

    // Step 1: Cache-first — show stale data immediately while network refreshes
    if (!forceRefresh) {
      try {
        const cached = sessionStorage.getItem('ca_projects_cache');
        if (cached) {
          const data = JSON.parse(cached) as { name: string; dir: string }[];
          setProjects(data);
          cacheApplied = true;
          if (data.length > 0) {
            // Use saved session selection if still valid, otherwise default to first
            const savedDir = sessionStorage.getItem('ca_selected_project_dir');
            const dir = getDefaultProjectWithDir(data, savedDir);
            setSelectedProjectDir(dir);
            safeSessionStorageSetItem('ca_selected_project_dir', dir);
            fetchAnalysis(dir);
          }
        }
      } catch {
        sessionStorage.removeItem('ca_projects_cache');
      }
    }

    // Step 2: Network refresh (stale-while-revalidate)
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/projects`, { headers });

      // Race condition guard: discard response if a newer fetch started
      if (generation !== fetchGeneration) return;

      if (resp.ok) {
        const data = await resp.json();
        setProjects(data);
        safeSessionStorageSetItem('ca_projects_cache', JSON.stringify(data));

        if (data.length > 0) {
          const hasSelected = data.some((p: { name: string; dir: string }) => p.dir === selectedProjectDir);
          if (hasSelected && selectedProjectDir) {
            // Skip fetchAnalysis if cache already handled it (avoids double call)
            if (!cacheApplied) {
              fetchAnalysis(selectedProjectDir);
            }
          } else {
            // Selected project changed — pick default and fetch fresh data
            const defaultDir = data[0].dir;
            setSelectedProjectDir(defaultDir);
            safeSessionStorageSetItem('ca_selected_project_dir', defaultDir);
            fetchAnalysis(defaultDir);
          }
        } else {
          clearAllCaches();
        }
      } else {
        // Only clear caches if cache didn't already restore data
        if (!cacheApplied) {
          clearAllCaches();
        }
      }
    } catch (err) {
      console.error("Failed to fetch projects:", err);
      // Preserve cached data on network error (graceful degradation)
    }
  };

  const handleProjectChange = (dir: string) => {
    setSelectedProjectDir(dir);
    safeSessionStorageSetItem('ca_selected_project_dir', dir);
    fetchAnalysis(dir);
  };

  const handleReindex = async () => {
    setIsIndexing(true);
    if (selectedProjectDir) {
      memoryAnalysisCache.delete(selectedProjectDir);
      sessionStorage.removeItem(`ca_analysis_cache_${selectedProjectDir}`);
      sessionStorage.removeItem('ca_analysis_cache');
    }
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/reindex`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectDir: selectedProjectDir })
      });
      if (resp.ok) await fetchAnalysis(selectedProjectDir, true);
    } catch (err) {
      console.error("Re-index failed:", err);
    } finally {
      setIsIndexing(false);
    }
  };

  const handleDeleteProject = async () => {
    if (!selectedProjectDir) return;
    try {
      const headers = await getAuthHeaders();
      const resp = await fetch(`${API_BASE}/api/projects?projectDir=${encodeURIComponent(selectedProjectDir)}`, {
        method: 'DELETE',
        headers
      });
      if (resp.ok) {
        alert("Project successfully removed!");
        setAnalysis(null);
        setSelectedProjectDir('');
        memoryAnalysisCache.delete(selectedProjectDir);
        sessionStorage.removeItem(`ca_analysis_cache_${selectedProjectDir}`);
        sessionStorage.removeItem(`codeatlas_indexing_enabled_${selectedProjectDir}`);
        sessionStorage.removeItem('ca_analysis_cache');
        sessionStorage.removeItem('ca_selected_project_dir');
        await fetchProjects();
      } else {
        let errorMessage = 'Unknown error';
        try {
          const data = await resp.json();
          errorMessage = data.error || errorMessage;
        } catch {
          errorMessage = `Server returned status code ${resp.status}`;
        }

        if (errorMessage.includes("Remote cleanup failure")) {
          const forceConfirm = confirm(`Remote DB cleanup failed: ${errorMessage}\
\nDo you want to force local deletion and unregister the project anyway?`);
          if (forceConfirm) {
            try {
              const forceResp = await fetch(`${API_BASE}/api/projects?projectDir=${encodeURIComponent(selectedProjectDir)}&force=true`, {
                method: 'DELETE',
                headers
              });
              if (forceResp.ok) {
                alert("Project successfully removed locally!");
                setAnalysis(null);
                setSelectedProjectDir('');
                memoryAnalysisCache.delete(selectedProjectDir);
                sessionStorage.removeItem(`ca_analysis_cache_${selectedProjectDir}`);
                sessionStorage.removeItem(`codeatlas_indexing_enabled_${selectedProjectDir}`);
                sessionStorage.removeItem('ca_analysis_cache');
                sessionStorage.removeItem('ca_selected_project_dir');
                await fetchProjects();
                return;
              } else {
                let forceErrorMessage = 'Unknown error';
                try {
                  const forceData = await forceResp.json();
                  forceErrorMessage = forceData.error || forceErrorMessage;
                } catch {
                  forceErrorMessage = `Server returned status code ${forceResp.status}`;
                }
                alert(`Failed to force delete project: ${forceErrorMessage}`);
              }
            } catch (forceErr) {
              console.error("Force delete project failed:", forceErr);
              alert(`Failed to force delete project: ${forceErr instanceof Error ? forceErr.message : String(forceErr)}`);
            }
          }
        } else {
          alert(`Failed to delete project: ${errorMessage}`);
        }
      }
    } catch (err) {
      console.error("Delete project failed:", err);
      alert(`Failed to delete project: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  useEffect(() => {
    if (!user) {
      // Clear user states on logout immediately
      clearAllCaches();
      return;
    }
    
    fetchProjects();

    const unsubscribeStats = onSnapshot(doc(db, 'users', user.uid), (snap: any) => {
      if (snap.exists() && snap.data().stats) setStats(snap.data().stats);
    });

    const q = query(collection(db, 'users', user.uid, 'keys'), orderBy('createdAt', 'desc'));
    const unsubscribeKeys = onSnapshot(q, (snap: any) => {
      setKeys(snap.docs.map(d => ({ id: d.id, ...d.data() })) as ApiKey[]);
    });

    return () => {
      unsubscribeStats();
      unsubscribeKeys();
    };
  }, [user]);

  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const createKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !newKeyName.trim()) return;
    setLoading(true);
    try {
      const rawKey = 'ca_' + crypto.randomUUID().replace(/-/g, '');
      const encoder = new TextEncoder();
      const data = encoder.encode(rawKey);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const keyHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      const keyPreview = rawKey.substring(0, 6) + '...' + rawKey.substring(rawKey.length - 4);

      await addDoc(collection(db, 'users', user.uid, 'keys'), {
        name: newKeyName,
        keyHash,
        keyPreview,
        tier: 'enterprise',
        createdAt: serverTimestamp()
      });
      setNewKeyName('');
      setCreatedKey(rawKey);
    } catch (err) { 
      console.error(err); 
    } finally { 
      setLoading(false); 
    }
  };

  const resolvedAnalysis = useMemo(() => {
    if (!analysis) return null;
    
    // Extract base analysis object if it's nested
    let base: AnalysisData = analysis;
    if (analysis.analysis) {
      base = analysis.analysis;
    }
    
    // Normalize stats
    const rawStats = base.stats || {};
    const entityCounts = base.entityCounts || {};
    const totalFilesAnalyzed = base.totalFilesAnalyzed || rawStats.totalFiles || 0;
    
    const normalizedStats = {
      totalFiles: totalFilesAnalyzed,
      totalModules: entityCounts.modules || rawStats.totalModules || 0,
      totalClasses: entityCounts.classes || rawStats.totalClasses || 0,
      totalFunctions: entityCounts.functions || rawStats.totalFunctions || 0,
      totalVariables: entityCounts.variables || rawStats.totalVariables || 0,
      loc: rawStats.loc || 0
    };
    
    return {
      ...base,
      stats: normalizedStats,
      totalFilesAnalyzed
    };
  }, [analysis]);

  const renderContent = () => {
    switch(activeTab) {
      case 'Control Center':
        return (
          <ControlCenterView 
            stats={stats} 
            keys={keys} 
            analysis={resolvedAnalysis}
            createKey={createKey} 
            deleteKey={(id: string) => deleteDoc(doc(db, 'users', user!.uid, 'keys', id))} 
            copyToClipboard={(t: string, id: string) => { 
              navigator.clipboard.writeText(t); 
              setCopiedId(id); 
              setTimeout(() => setCopiedId(null), 2000); 
            }}
            copiedId={copiedId} 
            newKeyName={newKeyName} 
            setNewKeyName={setNewKeyName} 
            loading={loading}
            createdKey={createdKey}
            clearCreatedKey={() => setCreatedKey(null)}
          />
        );
      case 'Knowledge Graph':
        return (
          <KnowledgeGraphView 
            analysis={resolvedAnalysis} 
            projects={projects}
            selectedProjectDir={selectedProjectDir}
            onProjectChange={handleProjectChange}
            onDeleteProject={handleDeleteProject}
          />
        );
      case 'Cloud Index':
        return (
          <CloudIndexView 
            analysis={resolvedAnalysis} 
            isIndexing={isIndexing} 
            onReindex={handleReindex} 
            isIndexingEnabled={isIndexingEnabled} 
            setIsIndexingEnabled={handleToggleIndexingEnabled} 
            isUpdatingSettings={isUpdatingSettings}
          />
        );
      case 'Documentation':
        return <DocumentationView />;
      case 'Dream Memory':
        return <DreamMemoryView />;
      case 'Second Brain':
        return <SecondBrainView />;
      default:
        return null;
    }
  };

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--background)', color: '#fff', overflow: 'hidden' }}>
      
      {/* SIDEBAR */}
      <aside className="glass-panel" style={{ 
        width: '300px', minWidth: '300px', padding: '2.5rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '2.5rem',
        borderRight: '1px solid rgba(255,255,255,0.1)', height: '100vh', boxSizing: 'border-box'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0 0.5rem' }}>
          <div style={{ width: '45px', height: '45px', background: 'var(--primary-neon)', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--glow-primary)' }}>
            <ShieldCheck size={28} color="#000" />
          </div>
          <span className="tech-font" style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '0.05em' }}>CODEATLAS</span>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {[
            { icon: LayoutDashboard, label: 'Control Center' },
            { icon: Network, label: 'Knowledge Graph' },
            { icon: Globe, label: 'Cloud Index' },
            { icon: Brain, label: 'Dream Memory' },
            { icon: Lightbulb, label: 'Second Brain' },
            { icon: BookOpen, label: 'Documentation' },
          ].map((item) => (
            <motion.div
              key={item.label}
              whileHover={{ x: 5 }}
              onClick={() => setActiveTab(item.label)}
              style={{
                display: 'flex', alignItems: 'center', gap: '1.25rem', padding: '1rem', borderRadius: '14px', cursor: 'pointer',
                background: activeTab === item.label ? 'rgba(0, 240, 255, 0.12)' : 'transparent',
                color: activeTab === item.label ? 'var(--primary-neon)' : 'var(--text-muted)',
                border: activeTab === item.label ? '1px solid rgba(0, 240, 255, 0.25)' : '1px solid transparent',
                transition: 'all 0.2s ease'
              }}
            >
              <item.icon size={22} />
              <span style={{ fontSize: '0.95rem', fontWeight: 700 }}>{item.label}</span>
            </motion.div>
          ))}
        </nav>

        <div style={{ marginTop: 'auto', padding: '1.25rem', background: 'rgba(0,0,0,0.25)', borderRadius: '20px', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: 700 }}>ENTERPRISE NODE</div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#fff', wordBreak: 'break-all' }}>{user?.email}</div>
          <button onClick={() => { sessionStorage.removeItem('ca_api_key'); auth.signOut(); window.location.reload(); }} style={{ marginTop: '1.5rem', width: '100%', display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#ff4b4b', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 700 }}>
            <LogOut size={18} /> SIGN OUT
          </button>
        </div>
      </aside>

      {/* MAIN AREA */}
      <main style={{ flex: 1, height: '100vh', overflowY: 'auto', padding: '3rem 4rem', boxSizing: 'border-box' }}>
        <AnimatePresence mode="wait">
          <motion.div key={activeTab} initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -15 }} transition={{ duration: 0.3 }}>
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>

      <style>{`
        .glass-panel { background: rgba(13, 17, 23, 0.7); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
        .tech-font { font-family: 'Inter', system-ui, -apple-system, sans-serif; letter-spacing: -0.02em; }
        .glass-input { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 0.875rem 1rem; border-radius: 12px; width: 100%; transition: all 0.3s; }
        .glass-input:focus { outline: none; border-color: var(--primary-neon); box-shadow: 0 0 15px rgba(0, 240, 255, 0.1); }
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .filter-chip { padding: 0.5rem 1rem; border-radius: 10px; background: rgba(255,255,255,0.05); cursor: pointer; border: 1px solid transparent; font-size: 0.8rem; font-weight: 700; transition: all 0.3s; color: var(--text-muted); display: flex; alignItems: center; gap: 0.5rem; }
        .filter-chip.active { background: rgba(0, 240, 255, 0.1); border-color: var(--primary-neon); color: var(--primary-neon); }
      `}</style>
    </div>
  );
};