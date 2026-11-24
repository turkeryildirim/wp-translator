import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/open.ts';
import { listAiAgents, updateAiAgent } from '../src/db/aiSettings.ts';

describe('aiSettings database operations', () => {
  it('lists default AI agents and updates agent configuration', () => {
    const db = openDb(':memory:');
    const agents = listAiAgents(db);
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.some((a) => a.id === 'opencode')).toBe(true);

    updateAiAgent(db, 'opencode', {
      enabled: false,
      model: 'my-custom-model',
      command: 'custom-opencode',
      bashSample: 'custom command line',
    });

    const updated = listAiAgents(db).find((a) => a.id === 'opencode');
    expect(updated).toBeDefined();
    expect(updated!.enabled).toBe(false);
    expect(updated!.model).toBe('my-custom-model');
    expect(updated!.command).toBe('custom-opencode');
    expect(updated!.bashSample).toBe('custom command line');

    // No-op update with empty fields
    updateAiAgent(db, 'opencode', {});
  });
});
