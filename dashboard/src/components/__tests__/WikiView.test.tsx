import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WikiView } from '../WikiView';
import { vi, describe, it, expect, beforeEach, afterEach, Mock } from 'vitest';

global.fetch = vi.fn();

function mockTreeResponse() {
  return { ok: true, json: async () => ({ root: [], totalPages: 0, projectName: 'test-project' }) };
}
function mockQueryResponse() {
  return { ok: true, json: async () => ({ answer: 'mock answer' }) };
}

describe('WikiView Component', () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.resetAllMocks();

    (global.fetch as Mock).mockImplementation(async (url: string) => {
      if (url.includes('/tree')) return mockTreeResponse();
      if (url.includes('/query')) return mockQueryResponse();
      return { ok: true, json: async () => ({}) };
    });
  });

  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('saves and selects a configuration profile to localStorage', async () => {
    const user = userEvent.setup();
    render(<WikiView projects={[{ name: 'test-project', dir: '/test' }]} selectedProjectDir="/test" />);

    await user.click(screen.getByText(/Rebuild Wiki/i));
    expect(screen.getByText(/LLM Settings & Generation/i)).toBeInTheDocument();

    const providerSelect = screen.getByRole('combobox', { name: /LLM Provider/i });
    await user.selectOptions(providerSelect, 'openai-compatible');

    const modelInput = screen.getByPlaceholderText(/claude-3-7-sonnet/i);
    await user.clear(modelInput);
    await user.type(modelInput, 'custom-llama-3');

    const baseUrlInput = screen.getByPlaceholderText(/127\.0\.0\.1/i);
    await user.clear(baseUrlInput);
    await user.type(baseUrlInput, 'http://test-url.local/v1');

    const configNameInput = screen.getByPlaceholderText(/e.g. My Claude Sub/i);
    await user.type(configNameInput, 'My Local Profile');

    const saveBtn = screen.getByRole('button', { name: /Save/i });
    await user.click(saveBtn);

    let profiles: any[] = [];
    await waitFor(() => {
      const stored = localStorage.getItem('ca_wiki_saved_profiles');
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed.length).toBe(1);
      profiles = parsed;
    }, { timeout: 1000 });

    expect(profiles[0].name).toBe('My Local Profile');
    expect(profiles[0].model).toBe('custom-llama-3');
    expect(profiles[0].baseUrl).toBe('http://test-url.local/v1');

    const presetSelect = screen.getByRole('combobox', { name: /Load Saved Preset/i });
    const options = Array.from(presetSelect.querySelectorAll('option'));
    expect(options.some(opt => opt.text === 'My Local Profile')).toBe(true);

    await user.clear(modelInput);
    expect(modelInput).toHaveValue('');

    await user.selectOptions(presetSelect, profiles[0].id);
    expect(modelInput).toHaveValue('custom-llama-3');
  });

  it('sends correct configuration when generating wiki', async () => {
    const user = userEvent.setup();
    render(<WikiView projects={[{ name: 'test-project', dir: '/test' }]} selectedProjectDir="/test" />);

    await user.click(screen.getByText(/Rebuild Wiki/i));
    await user.selectOptions(screen.getByRole('combobox', { name: /LLM Provider/i }), 'openai-compatible');

    const modelInput = screen.getByPlaceholderText(/claude-3-7-sonnet/i);
    await user.clear(modelInput);
    await user.type(modelInput, 'gpt-temp');

    const generateBtn = screen.getByRole('button', { name: /Start Generation|Generate Wiki/i });
    await user.click(generateBtn);

    const fetchMock = global.fetch as Mock;
    const generateCall = fetchMock.mock.calls.find((call: any) => typeof call[0] === 'string' && call[0].includes('/generate'));

    expect(generateCall).toBeDefined();
    if (generateCall) {
      const payload = JSON.parse(generateCall[1].body as string);
      expect(payload.provider).toBe('openai-compatible');
      expect(payload.model).toBe('gpt-temp');
    }
  });

  it('sends correct configuration when asking Wiki Assistant', async () => {
    localStorage.setItem('ca_wiki_provider', 'openai');
    localStorage.setItem('ca_wiki_model', 'gpt-4o');

    const user = userEvent.setup();
    render(<WikiView projects={[{ name: 'test-project', dir: '/test' }]} selectedProjectDir="/test" />);

    const input = screen.getByPlaceholderText(/Ask a question/i);
    await user.type(input, 'What does the user service do?');
    fireEvent.submit(input);

    const fetchMock = global.fetch as Mock;
    await waitFor(() => {
      const queryCall = fetchMock.mock.calls.find((call: any) => typeof call[0] === 'string' && call[0].includes('/query'));
      expect(queryCall).toBeDefined();

      if (queryCall) {
        const payload = JSON.parse(queryCall[1].body as string);
        expect(payload.query).toBe('What does the user service do?');
        expect(payload.provider).toBe('openai');
        expect(payload.model).toBe('gpt-4o');
      }
    });
  });

  it.each([false, true])('preserves saved presets unless deletion is confirmed (%s)', async (confirmed) => {
    const profiles = [
      { id: 'first', name: 'First preset', provider: 'mock', model: 'default', apiKey: '', baseUrl: '' },
      { id: 'second', name: 'Second preset', provider: 'mock', model: 'default', apiKey: '', baseUrl: '' },
    ];
    localStorage.setItem('ca_wiki_saved_profiles', JSON.stringify(profiles));
    localStorage.setItem('ca_wiki_active_profile_id', 'first');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(confirmed);
    const user = userEvent.setup();
    render(<WikiView projects={[{ name: 'test-project', dir: '/test' }]} selectedProjectDir="/test" />);

    await user.click(screen.getByText(/Rebuild Wiki/i));
    const presetSelect = screen.getByRole('combobox', { name: /Load Saved Preset/i });
    const deleteButton = screen.getByRole('button', { name: /Delete selected preset/i });
    await user.click(deleteButton);

    expect(confirm).toHaveBeenCalledTimes(1);
    if (confirmed) {
      expect(presetSelect).toHaveValue('');
      expect(screen.queryByRole('option', { name: 'First preset' })).not.toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Second preset' })).toBeInTheDocument();
      await waitFor(() => {
        expect(JSON.parse(localStorage.getItem('ca_wiki_saved_profiles')!)).toEqual([profiles[1]]);
        expect(localStorage.getItem('ca_wiki_active_profile_id')).toBe('');
      });
    } else {
      expect(presetSelect).toHaveValue('first');
      expect(screen.getByRole('option', { name: 'First preset' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Second preset' })).toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem('ca_wiki_saved_profiles')!)).toEqual(profiles);
    }
  });

  it('shows query progress in the submit button until the answer arrives', async () => {
    let finishQuery!: (response: ReturnType<typeof mockQueryResponse>) => void;
    const pendingQuery = new Promise<ReturnType<typeof mockQueryResponse>>(resolve => { finishQuery = resolve; });
    (global.fetch as Mock).mockImplementation(async (url: string) => {
      if (url.includes('/tree')) return mockTreeResponse();
      if (url.includes('/query')) return pendingQuery;
      return { ok: true, json: async () => ({}) };
    });
    const user = userEvent.setup();
    render(<WikiView projects={[{ name: 'test-project', dir: '/test' }]} selectedProjectDir="/test" />);
    await user.type(screen.getByPlaceholderText(/Ask a question/i), 'How does this work?');
    const submitButton = screen.getByRole('button', { name: 'Submit query' });
    await user.click(submitButton);

    await waitFor(() => {
      expect(submitButton).toBeDisabled();
      expect(submitButton.querySelector('.animate-spin')).not.toBeNull();
    });
    finishQuery(mockQueryResponse());
    await waitFor(() => {
      expect(screen.getByText('mock answer')).toBeInTheDocument();
      expect(submitButton.querySelector('.animate-spin')).toBeNull();
    });
  });

});
