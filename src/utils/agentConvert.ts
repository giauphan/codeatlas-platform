import { loadContextAtSessionStart } from '../services/llmService.js';

export async function convertToAgent(agent: string): Promise<string> {
  const context = await loadContextAtSessionStart('session', '', 'command-convert');

  if (agent === 'claude') {
    return `=== Claude Context ===\n${context}`;
  }

  // Default: return context with agent label
  return `=== ${agent.charAt(0).toUpperCase() + agent.slice(1)} Context ===\n${context}`;
}
