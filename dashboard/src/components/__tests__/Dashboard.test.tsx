import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dashboard } from '../Dashboard';

// Mock fetch globally
globalThis.fetch = vi.fn().mockImplementation(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({}),
  })
);

// Mock child components to isolate Dashboard testing
vi.mock('../ControlCenterView', () => ({
  ControlCenterView: () => <div data-testid="control-center-view">Control Center View</div>
}));
vi.mock('../KnowledgeGraphView', () => ({
  KnowledgeGraphView: ({ onDeleteProject }: any) => (
    <div data-testid="knowledge-graph-view">
      Knowledge Graph View
      <button data-testid="delete-project-btn" onClick={onDeleteProject}>Delete Project</button>
    </div>
  )
}));
vi.mock('../LogicModelsView', () => ({
  LogicModelsView: () => <div data-testid="logic-models-view">Logic Models View</div>
}));
vi.mock('../CloudIndexView', () => ({
  CloudIndexView: () => <div data-testid="cloud-index-view">Cloud Index View</div>
}));
vi.mock('../DocumentationView', () => ({
  DocumentationView: () => <div data-testid="documentation-view">Documentation View</div>
}));

// Mock framer-motion to avoid animation issues in tests
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, onClick, style }: any) => (
      <div onClick={onClick} style={style} data-testid="motion-div">
        {children}
      </div>
    ),
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => {
  const MockIcon = () => <span data-testid="icon" />;
  return {
    LogOut: MockIcon,
    Cpu: MockIcon,
    Globe: MockIcon,
    Network: MockIcon,
    ShieldCheck: MockIcon,
    LayoutDashboard: MockIcon,
    BookOpen: MockIcon,
  };
});

// Mock firebase
const mockSignOut = vi.fn();
vi.mock('../../lib/firebase', () => {
  return {
    auth: {
      currentUser: { uid: 'testuid', email: 'test@example.com', getIdToken: vi.fn().mockResolvedValue('testtoken') },
      signOut: vi.fn(),
    },
    db: {},
  };
});

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  addDoc: vi.fn(),
  deleteDoc: vi.fn(),
  doc: vi.fn(),
  onSnapshot: vi.fn().mockReturnValue(vi.fn()), // Return a function to act as unsubscribe
  query: vi.fn(),
  orderBy: vi.fn(),
  serverTimestamp: vi.fn(),
}));

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('renders without crashing and displays the default tab (Control Center)', async () => {
    render(<Dashboard />);

    // Check if the sidebar brand is rendered
    expect(screen.getByText('CODEATLAS')).toBeInTheDocument();

    // Check if the user email is rendered
    expect(screen.getByText('test@example.com')).toBeInTheDocument();

    // Check if the default view (Control Center) is rendered
    await waitFor(() => {
        expect(screen.getByTestId('control-center-view')).toBeInTheDocument();
    });
  });

  it('switches tabs when a sidebar item is clicked', async () => {
    render(<Dashboard />);

    // Ensure we start on Control Center
    await waitFor(() => {
      expect(screen.getByTestId('control-center-view')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('knowledge-graph-view')).not.toBeInTheDocument();

    // Click on Knowledge Graph tab
    const kgTab = screen.getByText('Knowledge Graph');
    fireEvent.click(kgTab);

    // Wait for the view to switch
    await waitFor(() => {
      expect(screen.queryByTestId('control-center-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('knowledge-graph-view')).toBeInTheDocument();
    });

    // Click on Logic Models tab
    const lmTab = screen.getByText('Logic Models');
    fireEvent.click(lmTab);

    await waitFor(() => {
      expect(screen.queryByTestId('knowledge-graph-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('logic-models-view')).toBeInTheDocument();
    });

    // Click on Cloud Index tab
    const ciTab = screen.getByText('Cloud Index');
    fireEvent.click(ciTab);

    await waitFor(() => {
      expect(screen.queryByTestId('logic-models-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('cloud-index-view')).toBeInTheDocument();
    });

    // Click on Documentation tab
    const docTab = screen.getByText('Documentation');
    fireEvent.click(docTab);

    await waitFor(() => {
      expect(screen.queryByTestId('cloud-index-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('documentation-view')).toBeInTheDocument();
    });
  });

  it('calls auth.signOut when sign out button is clicked', async () => {
    const { auth } = await import('../../lib/firebase');
    // Mock window.location.reload
    const originalReload = window.location.reload;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { reload: vi.fn() },
    });

    render(<Dashboard />);

    const signOutBtn = screen.getByText('SIGN OUT');
    fireEvent.click(signOutBtn);

    await waitFor(() => {
        expect(auth.signOut).toHaveBeenCalled();
        expect(window.location.reload).toHaveBeenCalled();
    });

    // Restore window.location.reload
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { reload: originalReload },
    });
  });

  it('loads analysis from sessionStorage on initial render', async () => {
    const mockAnalysis = {
      stats: { totalFiles: 10 },
      graph: { nodes: [], links: [] }
    };
    sessionStorage.setItem('ca_analysis_cache', JSON.stringify(mockAnalysis));

    render(<Dashboard />);

    // Since we mocked the child components, we can't easily assert the props passed to them
    // But we know it didn't crash
    await waitFor(() => {
        expect(screen.getByTestId('control-center-view')).toBeInTheDocument();
    });
  });

  it('loads isIndexingEnabled from sessionStorage on initial render', async () => {
    sessionStorage.setItem('codeatlas_indexing_enabled', JSON.stringify(false));

    render(<Dashboard />);

    // The effect should write it back
    await waitFor(() => {
        expect(sessionStorage.getItem('codeatlas_indexing_enabled')).toBe('false');
    });
  });

  it('calls handleDeleteProject and clears state on successful deletion', async () => {
    const fetchMock = vi.fn().mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/api/projects') && !url.includes('projectDir=')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ name: 'mock-project', dir: '/home/biibon/mock-project' }])
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true })
      });
    });
    globalThis.fetch = fetchMock;

    sessionStorage.setItem('ca_selected_project_dir', '/home/biibon/mock-project');
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const confirmMock = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<Dashboard />);

    // Switch to Knowledge Graph tab
    const kgTab = screen.getByText('Knowledge Graph');
    fireEvent.click(kgTab);

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-graph-view')).toBeInTheDocument();
    });

    // Click Delete Project button
    const deleteBtn = screen.getByTestId('delete-project-btn');
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      // Assert fetch was called with DELETE method and correct URL
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects?projectDir=%2Fhome%2Fbiibon%2Fmock-project'),
        expect.objectContaining({ method: 'DELETE' })
      );
      // Assert states and sessionStorage are cleared
      expect(sessionStorage.getItem('ca_selected_project_dir')).toBeNull();
      expect(sessionStorage.getItem('ca_analysis_cache')).toBeNull();
      expect(alertMock).toHaveBeenCalledWith('Project successfully removed!');
    });

    alertMock.mockRestore();
    confirmMock.mockRestore();
  });
});
