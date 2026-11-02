import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlCenterView } from '../ControlCenterView';

vi.mock('../../lib/auth', () => ({ getAuthHeaders: async () => ({}) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('ControlCenter token actions', () => {
  it('requires confirmation before deleting a token and keeps utility actions out of form submission', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const deleteKey = vi.fn().mockResolvedValue(undefined);
    const copy = vi.fn();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={submit}><ControlCenterView
      stats={{ totalRequests: 0 }} keys={[{ id: 'token-1', key: 'synthetic-token', name: 'Test' }]}
      analysis={null} createKey={vi.fn()} deleteKey={deleteKey} copyToClipboard={copy}
      copiedId={null} loading={false}
    /></form>);
    fireEvent.click(screen.getByRole('button', { name: 'Delete token' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(deleteKey).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete token' }));
    expect(deleteKey).toHaveBeenCalledExactlyOnceWith('token-1');
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(copy).toHaveBeenCalledExactlyOnceWith('synthetic-token', 'token-1');
    expect(submit).not.toHaveBeenCalled();
  });
});
