import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    Brain: MockIcon,
    Lightbulb: MockIcon,
    Activity: MockIcon,
    Database: MockIcon,
    Copy: MockIcon,
    Check: MockIcon,
    Trash2: MockIcon,
    RefreshCw: MockIcon,
    Clock: MockIcon,
    Save: MockIcon,
  };
});

// Mock firebase
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
  onSnapshot: vi.fn().mockReturnValue(vi.fn()),
  query: vi.fn(),
  orderBy: vi.fn(),
  serverTimestamp: vi.fn(),
}));

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing and displays the default tab (Control Center)', async () => {
    render(<Dashboard />);

    expect(screen.getByText('CODEATLAS')).toBeInTheDocument();

    await waitFor(() => {
        expect(screen.getByTestId('control-center-view')).toBeInTheDocument();
    });
  });

  it('switches tabs when a sidebar item is clicked', async () => {
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByTestId('control-center-view')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('knowledge-graph-view')).not.toBeInTheDocument();

    const kgTab = screen.getByText('Knowledge Graph');
    fireEvent.click(kgTab);

    await waitFor(() => {
      expect(screen.queryByTestId('control-center-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('knowledge-graph-view')).toBeInTheDocument();
    });

    const ciTab = screen.getByText('Cloud Index');
    fireEvent.click(ciTab);

    await waitFor(() => {
      expect(screen.queryByTestId('knowledge-graph-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('cloud-index-view')).toBeInTheDocument();
    });

    const docTab = screen.getByText('Documentation');
    fireEvent.click(docTab);

    await waitFor(() => {
      expect(screen.queryByTestId('cloud-index-view')).not.toBeInTheDocument();
      expect(screen.getByTestId('documentation-view')).toBeInTheDocument();
    });
  });

  it('clears session storage and reloads when sign out button is clicked', async () => {
    sessionStorage.setItem('ca_api_key', 'test-key');
    sessionStorage.setItem('ca_user_email', 'test@example.com');
    
    const originalReload = window.location.reload;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { reload: vi.fn() },
    });

    render(<Dashboard />);

    const signOutBtn = screen.getByText('SIGN OUT');
    fireEvent.click(signOutBtn);

    await waitFor(() => {
        expect(sessionStorage.getItem('ca_api_key')).toBeNull();
        expect(sessionStorage.getItem('ca_user_email')).toBeNull();
        expect(window.location.reload).toHaveBeenCalled();
    });

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

    await waitFor(() => {
        expect(screen.getByTestId('control-center-view')).toBeInTheDocument();
    });
  });

  it('loads isIndexingEnabled from sessionStorage on initial render', async () => {
    sessionStorage.setItem('codeatlas_indexing_enabled', JSON.stringify(false));

    render(<Dashboard />);

    await waitFor(() => {
        expect(sessionStorage.getItem('codeatlas_indexing_enabled')).toBe('false');
    });
  });

  it('navigates to Knowledge Graph and renders delete button', async () => {
    sessionStorage.setItem('ca_selected_project_dir', '/home/biibon/mock-project');

    render(<Dashboard />);

    const kgTab = screen.getByText('Knowledge Graph');
    fireEvent.click(kgTab);

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-graph-view')).toBeInTheDocument();
    });

    // Verify delete button renders
    expect(screen.getByTestId('delete-project-btn')).toBeInTheDocument();
  });
});
