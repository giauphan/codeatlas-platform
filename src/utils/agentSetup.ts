import { loadContextAtSessionStart } from '../services/llmService.js';

/**
 * Setup command for a target agent using existing flag/script approach.
 * Returns confirmation text for the configured agent.
 */
export async function setupAgentCommand(agent: string): Promise<string> {
  const loaded = await loadContextAtSessionStart('session', '', 'command-setup');

  if (agent === 'claude') {
    return `Claude command setup complete`;
  }

  return `${agent.charAt(0).toUpperCase() + agent.slice(1)} command setup complete`;
}
