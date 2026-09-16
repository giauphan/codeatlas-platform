import { logger } from "../utils/logger.js";

export interface LLMGenerateOptions {
  prompt: string;
  systemPrompt?: string;
  provider?: 'anthropic' | 'openai' | 'openai-compatible' | 'template';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export class LLMProviderService {
  /**
   * Generates text using the selected LLM provider or falls back to offline template.
   */
  async generateText(options: LLMGenerateOptions): Promise<string> {
    const provider = this.resolveProvider(options);

    if (provider === 'template') {
      return this.generateTemplateResponse(options.prompt, options.systemPrompt);
    }

    try {
      if (provider === 'anthropic') {
        return await this.callAnthropic(options);
      } else if (provider === 'openai') {
        return await this.callOpenAI(options);
      } else if (provider === 'openai-compatible') {
        return await this.callOpenAICompatible(options);
      }
    } catch (error) {
      logger.warn(`LLM Provider '${provider}' call failed, falling back to template generator`, {
        error: error instanceof Error ? error.message : String(error)
      });
      return this.generateTemplateResponse(options.prompt, options.systemPrompt);
    }

    return this.generateTemplateResponse(options.prompt, options.systemPrompt);
  }

  /**
   * Summarizes an AST module using configured LLM or structured template fallback.
   */
  async summarizeModule(
    moduleName: string,
    astContext: Record<string, unknown>,
    options?: Partial<LLMGenerateOptions>
  ): Promise<string> {
    const provider = this.resolveProvider(options);

    if (provider === 'template') {
      return this.generateModuleTemplate(moduleName, astContext);
    }

    const prompt = this.buildModulePrompt(moduleName, astContext);
    const fullOptions: LLMGenerateOptions = {
      prompt,
      systemPrompt: 'You are an expert technical documentation assistant. Provide a clear, comprehensive module summary.',
      ...options,
      provider
    };

    try {
      return await this.generateText(fullOptions);
    } catch {
      return this.generateModuleTemplate(moduleName, astContext);
    }
  }

  private resolveProvider(options?: Partial<LLMGenerateOptions>): 'anthropic' | 'openai' | 'openai-compatible' | 'template' {
    if (options?.provider) {
      if (options.provider === 'template') {
        return 'template';
      }
      if (options.provider === 'anthropic') {
        const key = options.apiKey || process.env.ANTHROPIC_API_KEY;
        return key ? 'anthropic' : 'template';
      }
      if (options.provider === 'openai') {
        const key = options.apiKey || process.env.OPENAI_API_KEY;
        return key ? 'openai' : 'template';
      }
      if (options.provider === 'openai-compatible') {
        return 'openai-compatible';
      }
    }

    if (process.env.ANTHROPIC_API_KEY) {
      return 'anthropic';
    }
    if (process.env.OPENAI_API_KEY) {
      return 'openai';
    }

    return 'template';
  }

  private async callAnthropic(options: LLMGenerateOptions): Promise<string> {
    const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return this.generateTemplateResponse(options.prompt, options.systemPrompt);
    }

    const model = options.model || 'claude-3-5-sonnet-20241022';
    // Fixed endpoint: always use the official Anthropic API endpoint to prevent request forgery
    const url = 'https://api.anthropic.com/v1/messages';

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
        messages: [{ role: 'user', content: options.prompt }]
      })
    });

    if (!res.ok) {
      throw new Error(`Anthropic API returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as unknown;
    if (
      typeof data === 'object' &&
      data !== null &&
      'content' in data &&
      Array.isArray((data as { content: unknown }).content) &&
      (data as { content: Array<{ text?: unknown }> }).content.length > 0 &&
      typeof (data as { content: Array<{ text?: unknown }> }).content[0].text === 'string'
    ) {
      return (data as { content: Array<{ text: string }> }).content[0].text;
    }

    throw new Error('Invalid response structure from Anthropic API');
  }

  private async callOpenAI(options: LLMGenerateOptions): Promise<string> {
    const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return this.generateTemplateResponse(options.prompt, options.systemPrompt);
    }

    let endpoint = 'https://api.openai.com/v1/chat/completions';
    if (options.baseUrl) {
      try {
        const parsed = new URL(options.baseUrl);
        if (
          (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
          !parsed.hostname.toLowerCase().includes('metadata')
        ) {
          const safeBase = parsed.origin + parsed.pathname.replace(/\/+$/, '');
          endpoint = safeBase + '/chat/completions';
        }
      } catch {}
    }
    const model = options.model || 'gpt-4o-mini';
    return this.callOpenAIFormatEndpoint(endpoint, apiKey, model, options);
  }

  private async callOpenAICompatible(options: LLMGenerateOptions): Promise<string> {
    const apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
    let endpoint = 'http://127.0.0.1:11434/v1/chat/completions';
    if (options.baseUrl) {
      try {
        const parsed = new URL(options.baseUrl);
        if (
          (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') &&
          !parsed.hostname.toLowerCase().includes('metadata')
        ) {
          const safeBase = parsed.origin + parsed.pathname.replace(/\/+$/, '');
          endpoint = safeBase + '/chat/completions';
        }
      } catch {}
    }
    const model = options.model || 'default';
    return this.callOpenAIFormatEndpoint(endpoint, apiKey, model, options);
  }

  private async callOpenAIFormatEndpoint(
    endpointUrl: string,
    apiKey: string,
    model: string,
    options: LLMGenerateOptions
  ): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: options.prompt });

    // Enforce URL safety right before fetch, even though callers sanitize first
    let safeUrl = endpointUrl;
    if (safeUrl !== 'https://api.openai.com/v1/chat/completions') {
       const urlObj = new URL(safeUrl);
       if (urlObj.hostname !== '127.0.0.1' && urlObj.hostname !== 'localhost') {
         // Fallback to strict localhost if URL was somehow mutated
         safeUrl = 'http://127.0.0.1:11434/v1/chat/completions';
       }
    }

    const res = await fetch(safeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages
      })
    });

    if (!res.ok) {
      throw new Error(`OpenAI API endpoint returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as unknown;
    if (
      typeof data === 'object' &&
      data !== null &&
      'choices' in data &&
      Array.isArray((data as { choices: unknown }).choices) &&
      (data as { choices: Array<{ message?: { content?: unknown } }> }).choices.length > 0 &&
      typeof (data as { choices: Array<{ message?: { content?: unknown } }> }).choices[0].message?.content === 'string'
    ) {
      return (data as { choices: Array<{ message: { content: string } }> }).choices[0].message.content;
    }

    throw new Error('Invalid response structure from OpenAI format endpoint');
  }

  private buildModulePrompt(moduleName: string, astContext: Record<string, unknown>): string {
    return `Summarize module '${moduleName}'.\nAST Context:\n${JSON.stringify(astContext, null, 2)}`;
  }

  private generateModuleTemplate(moduleName: string, astContext: Record<string, unknown>): string {
    const lines: string[] = [];
    lines.push(`# Module Summary: ${moduleName}\n`);

    if (typeof astContext.filePath === 'string') {
      lines.push(`**File Path:** \`${astContext.filePath}\`\n`);
    }

    lines.push(`## Overview`);
    lines.push(`Automated summary for module \`${moduleName}\`.\n`);

    if (Array.isArray(astContext.functions) && astContext.functions.length > 0) {
      lines.push(`## Exported Functions`);
      for (const fn of astContext.functions) {
        lines.push(`- \`${String(fn)}\``);
      }
      lines.push('');
    }

    if (Array.isArray(astContext.classes) && astContext.classes.length > 0) {
      lines.push(`## Exported Classes`);
      for (const cls of astContext.classes) {
        lines.push(`- \`${String(cls)}\``);
      }
      lines.push('');
    }

    if (Array.isArray(astContext.dependencies) && astContext.dependencies.length > 0) {
      lines.push(`## Dependencies`);
      for (const dep of astContext.dependencies) {
        lines.push(`- \`${String(dep)}\``);
      }
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  private generateTemplateResponse(prompt: string, systemPrompt?: string): string {
    const lines: string[] = [];
    lines.push('# Documentation Generator (Template Mode)\n');
    if (systemPrompt) {
      lines.push(`**System Instructions:** ${systemPrompt}\n`);
    }
    lines.push('## Generated Content');
    lines.push(prompt);
    return lines.join('\n').trim();
  }
}
