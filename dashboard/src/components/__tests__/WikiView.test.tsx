import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WikiView } from '../WikiView';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

global.fetch = vi.fn();

describe('WikiView Component', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();

    const mockFetch = global.fetch as typeof vi.fn;
    mockFetch.mockImplementation(async (url) => {
      if (typeof url === 'string' && url.includes('/tree')) {
        return {
          ok: true,
          json: async () => ({ root: [], totalPages: 0, projectName: 'test-project' }),
        };
      }
      return { ok: true, json: async () => ({ answer: 'mock answer' }) };
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('saves and selects a configuration profile to localStorage', async () => {
    const user = userEvent.setup();
    render(<WikiView projects={[{ name: 'test-project', dir: '/test' }]} selectedProjectDir="/test" />);

    // Open Config Modal
    await user.click(screen.getByText(/Rebuild Wiki/i));

    // Verify modal elements are visible
    expect(screen.getByText(/LLM Settings & Generation/i)).toBeInTheDocument();

    // Select provider and set values using role-based queries
    const providerSelect = screen.getByRole('combobox', { name: /LLM Provider/i });
    await user.selectOptions(providerSelect, 'openai-compatible');

    const modelInput = screen.getByPlaceholderText(/claude-3-7-sonnet/i);
    await user.type(modelInput, 'custom-llama-3');

    const baseUrlInput = screen.getByPlaceholderText(/127\.0\.0\.1/i);
    await user.type(baseUrlInput, 'http://test-url.local/v1');
    
    // Save Preset
    const configNameInput = screen.getByPlaceholderText(/Config Name/i);
    await user.type(configNameInput, 'My Local Profile');
    
    const saveBtn = screen.getByRole('button', { name: /Save/i });
    await user.click(saveBtn);

    // Verify localStorage has saved it
    const storedProfilesStr = localStorage.getItem('ca_wiki_saved_profiles');
    expect(storedProfilesStr).not.toBeNull();
    const profiles = JSON.parse(storedProfilesStr!);
    expect(profiles.length).toBe(1);
    expect(profiles[0].name).toBe('My Local Profile');
    expect(profiles[0].model).toBe('custom-llama-3');
    expect(profiles[0].baseUrl).toBe('http://test-url.local/v1');
    
    // Check that we can select it (Load Saved Preset)
    const presetSelect = screen.getByRole('combobox', { name: /Load Saved Preset/i });
    const options = Array.from(presetSelect.querySelectorAll('option'));
    expect(options.some(opt => opt.text === 'My Local Profile')).toBe(true);
    
    // Let's clear the model input manually and then load the preset
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
    await user.type(modelInput, 'gpt-temp');
    
    // Generate
    const generateBtn = screen.getByRole('button', { name: /Start Generation|Generate Wiki/i });
    await user.click(generateBtn);

    const mockFetch = global.fetch as typeof vi.fn;
    const generateCall = mockFetch.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('/generate'));
    
    expect(generateCall).toBeDefined();
    if (generateCall) {
      const fetchParams = generateCall[1];
      const payload = JSON.parse(fetchParams.body as string);
      expect(payload.provider).toBe('openai-compatible');
      expect(payload.model).toBe('gpt-temp');
    }
  });

  it('sends correct configuration when asking Wiki Assistant', async () => {
    // Setup initial config in localStorage mimicking an active configuration
    localStorage.setItem('ca_wiki_provider', 'openai');
    localStorage.setItem('ca_wiki_model', 'gpt-4o');
    localStorage.setItem('ca_wiki_api_key', 'test-key-123');

    const user = userEvent.setup();
    render(<WikiView projects={[{ name: 'test-project', dir: '/test' }]} selectedProjectDir="/test" />);

    // Ask a question in the sidebar
    const input = screen.getByPlaceholderText(/Ask a question/i);
    await user.type(input, 'What does the user service do?');
    
    // Since Send is an icon, we can submit the form
    fireEvent.submit(input);

    const mockFetch = global.fetch as typeof vi.fn;
    await waitFor(() => {
      const queryCall = mockFetch.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes('/query'));
      expect(queryCall).toBeDefined();
      
      if (queryCall) {
        const fetchParams = queryCall[1];
        const payload = JSON.parse(fetchParams.body as string);
        expect(payload.query).toBe('What does the user service do?');
        expect(payload.provider).toBe('openai');
        expect(payload.model).toBe('gpt-4o');
        expect(payload.apiKey).toBe('test-key-123');
      }
    });
  });
});
