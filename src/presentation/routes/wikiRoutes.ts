import express from 'express';
import rateLimit from 'express-rate-limit';
import { WikiService } from '../../services/wikiService.js';
import { createDatabaseAdapter } from '../../database/factory.js';
import { LLMProviderService } from '../../services/llmProviderService.js';
import { logger } from '../../utils/logger.js';
import { authMiddleware } from '../../middleware/auth.js';

const wikiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests to Wiki endpoints, please try again later' }
});

export function createWikiRouter(wikiService?: WikiService): express.Router {
  const router = express.Router();
  router.use(wikiRateLimiter);

  // Middleware to initialize or extract tracking/auth could go here
  // For the default production usage, we lazy-init WikiService if not provided
  const getWikiService = () => {
    if (wikiService) return wikiService;
    const db = createDatabaseAdapter();
    const llmProvider = new LLMProviderService(); // Use default configs
    return new WikiService(db, llmProvider);
  };

  /**
   * POST /api/wiki/:project/generate
   * Generates or rebuilds the project wiki layout.
   */
  router.post('/:project/generate', async (req, res) => {
    try {
      const { project } = req.params;
      if (!project) {
        return res.status(400).json({ error: 'Missing logic required: projectName parameter' });
      }

      const { provider, apiKey, baseUrl, model, systemPrompt } = req.body || {};
      const cleanBaseUrl = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : undefined;
      if (provider && !["anthropic", "openai", "openai-compatible", "template", "mock"].includes(provider)) { return res.status(400).json({ error: "Invalid provider" }); }
      const options = { provider, apiKey, baseUrl: cleanBaseUrl, model, systemPrompt };
      const service = getWikiService();

      const result = await service.generateProjectWiki(project, options);
      res.json(result);
    } catch (err) {
      logger.error(`[WikiRoutes] generateProjectWiki failed:`, err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * GET /api/wiki/:project/tree
   * Returns the nested page tree structure.
   */
  router.get('/:project/tree', async (req, res) => {
    try {
      const { project } = req.params;
      const service = getWikiService();
      const tree = await service.getWikiTree(project);
      res.json(tree);
    } catch (err) {
      logger.error(`[WikiRoutes] getWikiTree failed:`, err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * GET /api/wiki/:project/page
   * Query params: ?path=/overview
   * Retrieves specific page content.
   */
  router.get('/:project/page', async (req, res) => {
    try {
      const { project } = req.params;
      const { path } = req.query;

      if (!path || typeof path !== 'string') {
        return res.status(400).json({ error: "Missing required 'path' query parameter" });
      }

      const service = getWikiService();
      const page = await service.getWikiPage(project, path);

      if (!page) {
        return res.status(404).json({ error: "Wiki page not found" });
      }

      res.json(page);
    } catch (err) {
      logger.error(`[WikiRoutes] getWikiPage failed:`, err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * POST /api/wiki/:project/query
   * Interactive Q&A against the wiki.
   */
  router.post('/:project/query', async (req, res) => {
    try {
      const { project } = req.params;
      const { query, provider, apiKey, baseUrl, model } = req.body || {};
      const cleanBaseUrl = typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : undefined;
      if (provider && !["anthropic", "openai", "openai-compatible", "template", "mock"].includes(provider)) { return res.status(400).json({ error: "Invalid provider" }); }
      const options = { provider, apiKey, baseUrl: cleanBaseUrl, model };

      if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: "Missing or invalid 'query' parameter" });
      }

      const service = getWikiService();
      const result = await service.queryWiki(project, query, options);
      res.json(result);
    } catch (err) {
      logger.error(`[WikiRoutes] queryWiki failed:`, err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

export function mountWikiRoutes(app: express.Application): void {
  // Use rate limiting and authMiddleware for all wiki endpoints in production
  app.use('/api/wiki', wikiRateLimiter, authMiddleware, createWikiRouter());
}
