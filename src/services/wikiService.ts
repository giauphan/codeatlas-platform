import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { IDatabaseAdapter, WikiPageRecord } from '../database/adapters/interface.js';
import { LLMProviderService } from './llmProviderService.js';
import { logger } from '../utils/logger.js';

export interface WikiNode {
  path: string;
  title: string;
  summary?: string;
  children?: WikiNode[];
}

export interface WikiTreeResponse {
  projectName: string;
  root: WikiNode[];
  totalPages: number;
  lastGeneratedAt?: string;
}

export interface GenerateWikiOptions {
  provider?: LLMProviderType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  exportToDisk?: boolean;
  tenantId?: string;
}

export type LLMProviderType = 'anthropic' | 'openai' | 'openai-compatible' | 'template';

export interface QueryWikiOptions {
  tenantId?: string;
  provider?: LLMProviderType;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export class WikiService {
  constructor(
    private readonly dbAdapter: IDatabaseAdapter,
    private readonly llmProvider: LLMProviderService = new LLMProviderService()
  ) {}

  async generateProjectWiki(projectName: string, options: GenerateWikiOptions = {}): Promise<WikiTreeResponse> {
    if (!projectName || !/^[a-zA-Z0-9_\-\.]+$/.test(projectName)) {
      throw new Error('Invalid project name: contains invalid or unsafe characters');
    }

    const tenantId = options.tenantId || 'default';
    logger.info(`Generating wiki for project '${projectName}' (tenant: ${tenantId})`);

    // Clean up existing wiki pages
    await this.dbAdapter.deleteWikiPages(projectName, tenantId);

    const pagesToGenerate = [
      {
        path: '/overview',
        title: 'Overview',
        summary: 'Project overview and high-level architecture',
        parentPath: undefined,
        orderIndex: 0,
        prompt: `# Overview\n\nCreate a comprehensive overview for the project '${projectName}'. Include executive summary, assumed tech stack, and key components.`,
      },
      {
        path: '/architecture',
        title: 'Architecture',
        summary: 'System architecture and flow diagram',
        parentPath: undefined,
        orderIndex: 1,
        prompt: `Create an architecture document for '${projectName}' that MUST include a Mermaid diagram showing a typical layered system flow (Client -> Presentation -> Services -> Database). Format the diagram with \`\`\`mermaid.`,
      },
      {
        path: '/modules/services',
        title: 'Services Layer',
        summary: 'Domain logic and service components',
        parentPath: '/modules',
        orderIndex: 2,
        prompt: `Document the services layer for '${projectName}'. Explain how domain logic and orchestration should be structured.`,
      },
      {
        path: '/modules/database',
        title: 'Database Layer',
        summary: 'Persistence and database adapters',
        parentPath: '/modules',
        orderIndex: 3,
        prompt: `Document the database layer for '${projectName}'. Describe how persistence, adapters, and schemas are managed.`,
      },
    ];

    // Sanitize projectName to prevent directory traversal
    const safeProjectName = path.basename(projectName).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const rootWikiDir = path.resolve(process.cwd(), '.codeatlas', 'wiki');
    const exportBaseDir = path.resolve(rootWikiDir, safeProjectName);
    if (!exportBaseDir.startsWith(rootWikiDir)) {
      throw new Error('Invalid project name path traversal');
    }

    if (options.exportToDisk) {
      if (!fs.existsSync(exportBaseDir)) {
        fs.mkdirSync(exportBaseDir, { recursive: true });
      }
    }

    const timestamp = new Date().toISOString();

    for (const pageDef of pagesToGenerate) {
      const content = await this.llmProvider.generateText({
        prompt: pageDef.prompt,
        systemPrompt: 'You are an expert technical documentation assistant. Generate detailed markdown documentation.',
        provider: options.provider,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model,
      });

      const diagramMatch = content.match(/```mermaid[\s\S]*?```/);
      const diagramData = diagramMatch ? JSON.stringify({ type: 'mermaid', content: diagramMatch[0] }) : undefined;

      const record: WikiPageRecord = {
        id: crypto.randomUUID(),
        project_name: projectName,
        path: pageDef.path,
        title: pageDef.title,
        summary: pageDef.summary,
        content,
        diagram_data: diagramData,
        parent_path: pageDef.parentPath,
        order_index: pageDef.orderIndex,
        tenant_id: tenantId,
        created_at: timestamp,
        updated_at: timestamp,
      };

      await this.dbAdapter.saveWikiPage(record);

      if (options.exportToDisk) {
        // Sanitize path for file system: prevent traversal and ensure .md extension
        // e.g. /modules/services -> modules/services.md
        const normalizedPath = path.normalize(pageDef.path);
        const safePath = normalizedPath.replace(/^([\\\/]|(\.\.[\/\\]))+/, '');
        const fullPath = path.resolve(exportBaseDir, `${safePath}.md`);

        if (!fullPath.startsWith(exportBaseDir)) {
          throw new Error('Invalid wiki page path mapping');
        }

        const dirPath = path.dirname(fullPath);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
        fs.writeFileSync(fullPath, content, 'utf8');
      }
    }

    return this.getWikiTree(projectName, tenantId);
  }

  async getWikiTree(projectName: string, tenantId: string = 'default'): Promise<WikiTreeResponse> {
    const pages = await this.dbAdapter.listWikiPages(projectName, tenantId);

    if (pages.length === 0) {
      return {
        projectName,
        root: [],
        totalPages: 0,
      };
    }

    // Map DB records to WikiNodes
    const nodeMap = new Map<string, WikiNode>();
    for (const page of pages) {
      nodeMap.set(page.path, {
        path: page.path,
        title: page.title,
        summary: page.summary,
        children: [],
      });
    }

    // Automatically synthesize missing parent nodes if they don't exist
    for (const page of pages) {
      if (page.parent_path && !nodeMap.has(page.parent_path)) {
        // Extract a title for the synthesized parent from its path name
        const titleMatch = page.parent_path.match(/([^\/]+)$/);
        const title = titleMatch ? titleMatch[1].charAt(0).toUpperCase() + titleMatch[1].slice(1) : page.parent_path;

        nodeMap.set(page.parent_path, {
          path: page.parent_path,
          title,
          children: [],
        });
      }
    }

    const root: WikiNode[] = [];
    const synthesizedPaths = new Set<string>();

    for (const page of pages) {
      if (page.parent_path && !nodeMap.has(page.parent_path)) {
        const titleMatch = page.parent_path.match(/([^\/]+)$/);
        const title = titleMatch ? titleMatch[1].charAt(0).toUpperCase() + titleMatch[1].slice(1) : page.parent_path;

        nodeMap.set(page.parent_path, {
          path: page.parent_path,
          title,
          children: [],
        });
        synthesizedPaths.add(page.parent_path);
      }
    }

    // Link children to parents and collect root nodes in a single pass O(N)
    for (const page of pages) {
      const node = nodeMap.get(page.path)!;
      if (page.parent_path && nodeMap.has(page.parent_path)) {
        nodeMap.get(page.parent_path)!.children!.push(node);
      } else {
        root.push(node);
      }
    }

    // Handle synthesized parents connection
    for (const synthPath of synthesizedPaths) {
      const node = nodeMap.get(synthPath)!;
      const parentPath = this.extractParentPath(synthPath);
      if (parentPath && nodeMap.has(parentPath)) {
         nodeMap.get(parentPath)!.children!.push(node);
      } else {
         root.push(node);
      }
    }

    // Single look-up map for order
    const orderMap = new Map<string, number>();
    for (const page of pages) orderMap.set(page.path, page.order_index ?? 999);

    const sortByOrder = (a: WikiNode, b: WikiNode) => {
      const indexA = orderMap.get(a.path) ?? 999;
      const indexB = orderMap.get(b.path) ?? 999;
      if (indexA !== indexB) return indexA - indexB;
      return a.path.localeCompare(b.path);
    };

    root.sort(sortByOrder);
    for (const node of nodeMap.values()) {
      if (node.children && node.children.length > 0) {
        node.children.sort(sortByOrder);
      } else {
        delete node.children; // Clean up empty children arrays
      }
    }

    // Determine latest updated_at using one pass
    let lastGeneratedAt: string | undefined = undefined;
    for (const current of pages) {
      if (!current.updated_at) continue;
      if (!lastGeneratedAt || new Date(current.updated_at) > new Date(lastGeneratedAt)) {
        lastGeneratedAt = current.updated_at;
      }
    }

    return {
      projectName,
      root,
      totalPages: pages.length,
      lastGeneratedAt,
    };
  }

  async getWikiPage(projectName: string, path: string, tenantId: string = 'default'): Promise<WikiPageRecord | null> {
    return await this.dbAdapter.getWikiPage(projectName, path, tenantId);
  }

  async queryWiki(projectName: string, query: string, options: QueryWikiOptions | string = {}): Promise<{ answer: string; references: string[] }> {
    const opts: QueryWikiOptions = typeof options === 'string' ? { tenantId: options } : (options || {});
    const tenantId = opts.tenantId || 'default';
    const pages = await this.dbAdapter.listWikiPages(projectName, tenantId);

    // Very basic keyword matching/scoring for demo purposes.
    // In production, use vector embeddings.
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

    let scoredPages = pages.map(page => {
      let score = 0;
      const contentLower = page.content.toLowerCase();
      const titleLower = page.title.toLowerCase();

      for (const term of queryTerms) {
        if (titleLower.includes(term)) score += 5;
        if (contentLower.includes(term)) score += 1;
      }
      return { page, score };
    });

    // Filter to relevant stuff, or take all if list is short
    scoredPages.sort((a, b) => b.score - a.score || a.page.order_index! - b.page.order_index! || a.page.path.localeCompare(b.page.path));
    const topContexts = scoredPages.slice(0, 3).filter(p => p.score > 0 || scoredPages.length <= 3);

    const references = topContexts.map(scp => scp.page.path);

    const contextStr = topContexts.map(scp => `--- Page: ${scp.page.title} (${scp.page.path}) ---\n${scp.page.content}`).join('\n\n');

    const prompt = `Context from Project Wiki:\n${contextStr}\n\nUser Query: ${query}\n\nPlease answer the user query based on the context above. Cite the paths of pages you used to formulate your answer.`;

    const answer = await this.llmProvider.generateText({
      prompt,
      systemPrompt: 'You are an advanced documentation QA assistant running on CodeAtlas platform.',
      provider: opts.provider,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
    });

    return {
      answer,
      references
    };
  }

  /**
   * Search project Wiki for context matching a query.
   * Returns page excerpts and paths for agent context.
   * Does NOT invoke LLM — low-cost retrieval only.
   *
   * @param projectName - Project to search
   * @param query - Search terms
   * @param options - Optional tenantId, maxPages (default 3), maxChars (default 500)
   * @returns { pages: { path: string; title: string; excerpt: string }[] }
   */
  async searchWiki(projectName: string, query: string, options: { tenantId?: string; maxPages?: number; maxChars?: number } = {}): Promise<{ pages: { path: string; title: string; excerpt: string }[] }> {
    const tenantId = options.tenantId || 'default';
    const maxPages = Math.max(0, Math.min(options.maxPages ?? 3, 10));
    const maxChars = Math.max(0, Math.min(options.maxChars ?? 500, 2000));
    const pages = await this.dbAdapter.listWikiPages(projectName, tenantId);

    // Reuse keyword scoring from queryWiki but return excerpts only
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const scoredPages = pages.map(page => {
      let score = 0;
      const contentLower = page.content.toLowerCase();
      const titleLower = page.title.toLowerCase();

      for (const term of queryTerms) {
        if (titleLower.includes(term)) score += 5;
        if (contentLower.includes(term)) score += 1;
      }
      return { page, score };
    });

    // Sort and bound results
    scoredPages.sort((a, b) => b.score - a.score || a.page.order_index! - b.page.order_index! || a.page.path.localeCompare(b.page.path));
    const topPages = scoredPages.slice(0, maxPages).filter(p => p.score > 0 || scoredPages.length <= maxPages);

    // Extract excerpts
    const results = topPages.map(scp => {
      const excerpt = scp.page.content.length > maxChars
        ? scp.page.content.substring(0, maxChars) + '...'
        : scp.page.content;
      return {
        path: scp.page.path,
        title: scp.page.title,
        excerpt
      };
    });

    return { pages: results };
  }

  private extractParentPath(pathStr: string): string | undefined {
    const parts = pathStr.split('/').filter(Boolean);
    if (parts.length <= 1) return undefined;
    parts.pop();
    return '/' + parts.join('/');
  }
}
