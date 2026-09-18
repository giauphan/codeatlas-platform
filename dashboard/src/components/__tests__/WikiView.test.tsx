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

  afterEach(() => { localStorage.clear(); });

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

    const storedProfilesStr = localStorage.getItem('ca_wiki_saved_profiles');
    expect(storedProfilesStr).not.toBeNull();
    const profiles = JSON.parse(storedProfilesStr!);
    expect(profiles.length).toBe(1);
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
});
