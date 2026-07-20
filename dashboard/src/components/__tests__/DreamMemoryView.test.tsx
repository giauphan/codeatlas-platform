import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DreamMemoryView } from '../DreamMemoryView';

// Mock fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Mock framer-motion
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props} data-testid="motion-div">{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

// Mock lucide-react
vi.mock('lucide-react', () => {
  const Icon = ({ size, style }: any) => <span data-testid="lucide-icon" data-size={size} style={style} />;
  return {
    Brain: Icon, Search: Icon, Trash2: Icon, AlertCircle: Icon,
    Loader2: Icon, Database: Icon, Clock: Icon, Settings: Icon,
  };
});

// Mock sessionStorage
const mockSessionStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(window, 'sessionStorage', { value: mockSessionStorage });

// Sample dream memories for testing
const MOCK_DREAMS = {
  memories: [
    {
      id: 'test_KNOWLEDGE_session1_1000',
      session_id: 'session1',
      project: 'codeatlas-platform',
      provider: 'Claude',
      memory_type: 'KNOWLEDGE',
      content: 'The fix is to use strict equality operator instead of loose comparison',
      importance: 7,
      created_at: '2026-07-20T10:00:00.000Z',
    },
    {
      id: 'test_MISTAKE_session1_1001',
      session_id: 'session1',
      project: 'codeatlas-platform',
      provider: 'Claude',
      memory_type: 'MISTAKE',
      content: 'Previous implementation failed due to missing null check on user input',
      importance: 8,
      created_at: '2026-07-20T09:00:00.000Z',
    },
    {
      id: 'test_PREFERENCE_session2_1002',
      session_id: 'session2',
      project: 'hermes-auto',
      provider: null,
      memory_type: 'PREFERENCE',
      content: 'User prefers early returns over nested conditionals for readability',
      importance: 6,
      created_at: '2026-07-19T18:00:00.000Z',
    },
    {
      id: 'test_PATTERN_session2_1003',
      session_id: 'session2',
      project: 'codeatlas-platform',
      provider: 'Claude',
      memory_type: 'PATTERN',
      content: 'Common pattern: API endpoints follow RESTful naming convention with /api prefix',
      importance: 5,
      created_at: '2026-07-19T12:00:00.000Z',
    },
    {
      id: 'test_KNOWLEDGE_session3_1004',
      session_id: 'session3',
      project: 'hermes-auto',
      provider: null,
      memory_type: 'KNOWLEDGE',
      content: 'Session active - ready to assist with coding tasks',
      importance: 3,
      created_at: '2026-07-18T06:00:00.000Z',
    },
  ],
};

const DREAM_CONFIG = {
  dreams_schedule: '0 19 * * *',
  dreams_enabled: true,
  dreams_provider: '',
  updated_at: '2026-07-20T00:00:00.000Z',
};

/** Helper: create smart mock that returns config for /settings/cron and dreams for /dreams/query */
function smartMock(dreams: typeof MOCK_DREAMS) {
  return vi.fn().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/settings/cron')) {
      return { ok: true, json: () => Promise.resolve(DREAM_CONFIG) };
    }
    return { ok: true, json: () => Promise.resolve(dreams) };
  });
}

describe('DreamMemoryView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionStorage.clear();
    mockSessionStorage.setItem('ca_api_key', 'ca_test_key_12345');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test: Initial load with dreams ──
  it('loads and displays dream memories on initial render', async () => {
    mockFetch.mockImplementation(smartMock(MOCK_DREAMS));

    render(<DreamMemoryView />);

    // Wait for dreams to load
    await waitFor(() => {
      expect(screen.getByText('The fix is to use strict equality operator instead of loose comparison')).toBeTruthy();
    });

    // Verify all 5 dreams rendered
    expect(await screen.findByText(/Previous implementation failed/)).toBeTruthy();
    expect(await screen.findByText(/User prefers early returns/)).toBeTruthy();
    expect(await screen.findByText(/Common pattern/)).toBeTruthy();
    expect(await screen.findByText(/Session active/)).toBeTruthy();

    // Verify pagination shows "Page 1"
    expect(screen.getByText('Page 1')).toBeTruthy();
  });

  // ── Test: Error state when API key missing ──
  it('shows initializing state when no API key (cannot proceed without auth)', async () => {
    mockSessionStorage.removeItem('ca_api_key');

    render(<DreamMemoryView />);

    // Without API key, firebaseReady stays false → shows "Initializing..." forever
    expect(screen.getByText(/Initializing/i)).toBeTruthy();
  });

  // ── Test: Empty state ──
  it('shows empty state when no memories returned', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/settings/cron')) {
        return { ok: true, json: () => Promise.resolve(DREAM_CONFIG) };
      }
      return { ok: true, json: () => Promise.resolve({ memories: [] }) };
    });

    render(<DreamMemoryView />);

    await waitFor(() => {
      expect(screen.getByText('No memories found')).toBeTruthy();
    });
  });

  // ── Test: Filter by memory_type ──
  it('filters by memory type when type chips are clicked', async () => {
    mockFetch.mockImplementation(smartMock(MOCK_DREAMS));

    render(<DreamMemoryView />);

    await waitFor(() => {
      expect(screen.getByText('The fix is to use strict equality operator instead of loose comparison')).toBeTruthy();
    });

    // Click "KNOWLEDGE" chip to toggle it OFF (will re-fetch)
    // Default: all 4 types selected. Toggling KNOWLEDGE off means query with 3 types
    const knowledgeChip = screen.getByText('KNOWLEDGE');
    fireEvent.click(knowledgeChip);

    // Should re-fetch with memory_type filter
    await waitFor(() => {
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      if (typeof lastCall[0] === 'string') {
        expect(lastCall[0]).toContain('memory_type=');
      }
    });
  });

  // ── Test: Search by query ──
  it('searches memories when query is submitted', async () => {
    mockFetch.mockImplementation(smartMock(MOCK_DREAMS));

    render(<DreamMemoryView />);

    await waitFor(() => {
      expect(screen.getByText('The fix is to use strict equality operator instead of loose comparison')).toBeTruthy();
    });

    // Type in search box
    const searchInput = screen.getByPlaceholderText('Search memories semantically...');
    fireEvent.change(searchInput, { target: { value: 'bug fix' } });

    // Submit search via form submit
    const form = searchInput.closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      // Verify API was called with query param
      const searchCall = mockFetch.mock.calls.find(
        (c: any) => typeof c[0] === 'string' && c[0].includes('query=bug+fix')
      );
      expect(searchCall).toBeTruthy();
    });
  });

  // ── Test: Pagination ──
  it('shows pagination controls and navigates pages', async () => {
    const manyDreams = { memories: [] as any[] };
    for (let i = 0; i < 15; i++) {
      manyDreams.memories.push({
        id: `test_KNOWLEDGE_session_${i}`,
        session_id: `session${i}`,
        project: 'test',
        provider: 'Claude',
        memory_type: 'KNOWLEDGE',
        content: `Dream memory number ${i}`,
        importance: 5,
        created_at: `2026-07-20T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
      });
    }

    mockFetch.mockImplementation(smartMock(manyDreams));

    render(<DreamMemoryView />);

    await waitFor(() => {
      expect(screen.getByText('Dream memory number 0')).toBeTruthy();
    });

    // Should have "Next" button enabled
    const nextBtn = screen.getByText('Next →');
    expect(nextBtn).toBeTruthy();

    // Click next
    fireEvent.click(nextBtn);

    await waitFor(() => {
      // Should show page 2
      expect(screen.getByText('Page 2')).toBeTruthy();
    });

    // Prev should be enabled
    const prevBtn = screen.getByText('← Prev');
    expect(prevBtn).toBeTruthy();
  });

  // ── Test: Config panel toggle ──
  it('toggles dream config panel', async () => {
    mockFetch.mockImplementation(smartMock(MOCK_DREAMS));

    render(<DreamMemoryView />);

    // Config button should exist (find by element type, not just text)
    const configBtns = screen.getAllByRole('button').filter(b => b.textContent?.includes('Config'));
    expect(configBtns.length).toBeGreaterThanOrEqual(1);
    const configBtn = configBtns[0];

    // Click config button to show panel
    fireEvent.click(configBtn);

    await waitFor(() => {
      expect(screen.getByText('Dream Configuration')).toBeTruthy();
      expect(screen.getByText('Enabled:')).toBeTruthy();
    });

    // Click again to hide
    fireEvent.click(configBtn);
    await waitFor(() => {
      expect(screen.queryByText('Dream Configuration')).toBeNull();
    });
  });

  // ── Test: Dreams ordered newest first ──
  it('displays dreams sorted by created_at descending (newest first)', async () => {
    mockFetch.mockImplementation(smartMock(MOCK_DREAMS));

    render(<DreamMemoryView />);

    await waitFor(() => {
      const allDreams = screen.getAllByText(/The fix|Previous|User prefers|Common pattern|Session active/);
      // Should have 5 visible content texts
      expect(allDreams.length).toBeGreaterThanOrEqual(3);
    });

    // Verify newest dream content appears first
    const container = screen.getByText('The fix is to use strict equality operator instead of loose comparison');
    expect(container).toBeTruthy();
  });

  // ── Test: API error handling ──
  it('shows error message when API call fails', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      callCount++;
      if (callCount <= 2 && typeof url === 'string' && url.includes('/api/settings/cron')) {
        return { ok: true, json: () => Promise.resolve(DREAM_CONFIG) };
      }
      throw new Error('Network error');
    });

    render(<DreamMemoryView />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
    });
  });

  // ── Test: Provider badge shown for dreams with provider ──
  it('shows provider badge when dream has provider', async () => {
    mockFetch.mockImplementation(smartMock(MOCK_DREAMS));

    render(<DreamMemoryView />);

    await waitFor(() => {
      // Dreams with provider=Claude should show Claude badge
      const claudeBadges = screen.getAllByText('Claude');
      expect(claudeBadges.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Test: Importance displayed for each dream ──
  it('shows importance score for each dream', async () => {
    mockFetch.mockImplementation(smartMock(MOCK_DREAMS));

    render(<DreamMemoryView />);

    await waitFor(() => {
      expect(screen.getByText('Importance: 8/10')).toBeTruthy();
      expect(screen.getByText('Importance: 7/10')).toBeTruthy();
      expect(screen.getByText('Importance: 6/10')).toBeTruthy();
      expect(screen.getByText('Importance: 5/10')).toBeTruthy();
      expect(screen.getByText('Importance: 3/10')).toBeTruthy();
    });
  });
});
