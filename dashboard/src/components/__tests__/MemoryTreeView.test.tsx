import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryTreeView } from '../MemoryTreeView';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

vi.mock('lucide-react', () => {
  const Icon = ({ size }: { size?: number }) => <span data-testid="icon" data-size={size} />;
  return {
    ChevronDown: Icon,
    ChevronRight: Icon,
    GitBranch: Icon,
    Loader2: Icon,
    RefreshCw: Icon,
  };
});

vi.mock('../../lib/auth', () => ({
  getAuthHeaders: vi.fn(async () => ({ 'x-api-key': 'test-key' })),
}));

const memories = {
  memories: [
    {
      id: 'knowledge-1',
      project: 'codeatlas-platform',
      memory_type: 'KNOWLEDGE',
      content: 'Use strict equality for comparisons',
      importance: 8,
      created_at: '2026-08-27T10:00:00.000Z',
      tags: ['typescript'],
    },
    {
      id: 'mistake-1',
      project: 'codeatlas-platform',
      memory_type: 'MISTAKE',
      content: 'Missing null check caused failure',
      importance: 6,
      created_at: '2026-08-26T10:00:00.000Z',
    },
  ],
};

function response(body: unknown) {
  return { ok: true, json: async () => body };
}

describe('MemoryTreeView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(response(memories));
  });

  it('loads memories and draws visual tree nodes', async () => {
    render(<MemoryTreeView />);

    await waitFor(() => expect(screen.getByRole('img', { name: 'Visual memory tree' })).toBeInTheDocument());

    const diagram = screen.getByRole('img', { name: 'Visual memory tree' });
    expect(diagram).toHaveTextContent('MEMORY');
    expect(diagram).toHaveTextContent('codeatlas-platform');
    expect(diagram).toHaveTextContent('KNOWLEDGE (1)');
    expect(diagram).toHaveTextContent('MISTAKE (1)');
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/dreams/query?limit=100'), expect.any(Object));
  });

  it('expands type branch to show memory content', async () => {
    render(<MemoryTreeView />);
    await screen.findByRole('img', { name: 'Visual memory tree' });

    const projectButton = screen.getAllByRole('button', { name: /codeatlas-platform/ })[0];
    fireEvent.click(projectButton);
    expect(projectButton).toHaveAttribute('aria-expanded', 'true');
    const knowledgeButton = screen.getAllByRole('button', { name: /KNOWLEDGE/ })[0];
    fireEvent.click(knowledgeButton);
    expect(knowledgeButton).toHaveAttribute('aria-expanded', 'true');

    expect(screen.getAllByText('Use strict equality for comparisons')).toHaveLength(2);
    expect(screen.getByText('Importance: 8/10 · 8/27/2026 · typescript')).toBeInTheDocument();
  });

  it('refreshes memories when refresh clicked', async () => {
    render(<MemoryTreeView />);
    await screen.findByRole('img', { name: 'Visual memory tree' });

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });

  it('loads more expanded category memories', async () => {
    const manyMemories = Array.from({ length: 13 }, (_, index) => ({
      id: `knowledge-${index}`,
      project: 'codeatlas-platform',
      memory_type: 'KNOWLEDGE',
      content: `Knowledge memory ${index + 1}`,
    }));
    mockFetch.mockResolvedValue(response({ memories: manyMemories }));
    render(<MemoryTreeView />);
    await screen.findByRole('img', { name: 'Visual memory tree' });

    fireEvent.click(screen.getAllByRole('button', { name: /codeatlas-platform/ })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /KNOWLEDGE/ })[0]);
    expect(screen.queryByText('Knowledge memory 13')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more (1 remaining)' }));
    expect(screen.getByText('Knowledge memory 13')).toBeInTheDocument();
  });

  it('shows empty state when API returns no memories', async () => {
    mockFetch.mockResolvedValue(response({ memories: [] }));
    render(<MemoryTreeView />);

    expect(await screen.findByText('No memories found.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Visual memory tree' })).toBeInTheDocument();
  });

  it('ignores malformed API memory records', async () => {
    mockFetch.mockResolvedValue(response({ memories: [{ id: 'valid', content: 'Valid memory' }, { content: '<script>bad</script>' }] }));
    render(<MemoryTreeView />);

    await waitFor(() => expect(screen.getByRole('img', { name: 'Visual memory tree' })).toBeInTheDocument());
    expect(screen.getByText('Valid memory')).toBeInTheDocument();
    expect(screen.queryByText('<script>bad</script>')).not.toBeInTheDocument();
  });

  it('shows session-expired error for unauthorized requests', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, text: async () => 'Unauthorized' });
    render(<MemoryTreeView />);

    expect(await screen.findByText('Session expired. Please log in again.')).toBeInTheDocument();
  });

  it('shows server error guidance', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'Internal error' });
    render(<MemoryTreeView />);

    expect(await screen.findByText('Memory server unavailable. Try again later.')).toBeInTheDocument();
  });

  it('shows API errors and retries', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Memory API unavailable' });
    mockFetch.mockResolvedValueOnce(response(memories));
    render(<MemoryTreeView />);

    expect(await screen.findByText('Memory server unavailable. Try again later.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('img', { name: 'Visual memory tree' })).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('shows an offline connectivity error', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<MemoryTreeView />);

    expect(await screen.findByText('Network connectivity issue. Check internet connection.')).toBeInTheDocument();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });
});
