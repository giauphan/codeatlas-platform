import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OrchestrationTasksView } from '../OrchestrationTasksView';
import type { A2AOrchestrationTask } from '../../../../src/types/a2a';

vi.mock('../../lib/auth', () => ({ getAuthHeaders: async () => ({}) }));
afterEach(() => { vi.unstubAllGlobals(); });

it('combines trimmed case-insensitive search with state filters and refreshed tasks', async () => {
  const task: A2AOrchestrationTask = {
    orchestrationTaskId: 'task-1', tenantId: 'tenant-1', leaderAgentId: 'leader-1',
    state: 'created', description: 'Build API', createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z', stateHistory: [],
  };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tasks: [task] }) });
  vi.stubGlobal('fetch', fetch);
  render(<OrchestrationTasksView />);
  await screen.findByText('Build API');
  const search = screen.getByRole('textbox');
  fireEvent.change(search, { target: { value: ' API ' } });
  expect(screen.getByText('Build API')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Approved' }));
  expect(screen.queryByText('Build API')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(screen.getByText('Build API')).toBeInTheDocument();
  fetch.mockResolvedValue({ ok: true, json: async () => ({ tasks: [{ ...task, description: 'Review API' }] }) });
  fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
  await screen.findByText('Review API');
  expect(screen.queryByText('Build API')).not.toBeInTheDocument();
});
