import { test, describe, beforeEach, mock, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactContext } from '../src/utils/noiseContext.js';
import { convertToAgent } from '../src/utils/agentConvert.js';
import { setupAgentCommand } from '../src/utils/agentSetup.js';

describe('Command Feature', () => {
  describe('compactContext', () => {
    it('removes noise using existing blocklist', async () => {
      const context = 'good memory\nweather note\nshopping list';
      const result = await compactContext(context);
      assert.ok(result.includes('good memory'));
      assert.ok(!result.includes('weather note'));
      assert.ok(!result.includes('shopping list'));
    });
  });

  describe('convertToAgent', () => {
    it('formats Claude header', async () => {
      const result = await convertToAgent('claude');
      assert.ok(result.includes('=== Claude Context ==='));
    });
  });

  describe('setupAgentCommand', () => {
    it('confirms Claude setup', async () => {
      const result = await setupAgentCommand('claude');
      assert.ok(result.includes('Claude command setup complete'));
    });
  });
});
