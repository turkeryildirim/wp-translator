import type { Db } from './open.ts';

export interface AiAgentRecord {
  id: string;
  name: string;
  command: string;
  model: string;
  defaultModel: string;
  enabled: boolean;
  icon: string;
  bashSample: string;
  description: string;
}

export function listAiAgents(db: Db): AiAgentRecord[] {
  const rows = db
    .prepare(
      `SELECT id, name, command, model, default_model AS defaultModel,
              enabled, icon, bash_sample AS bashSample, description
         FROM ai_agents
        ORDER BY id ASC`,
    )
    .all() as Array<Omit<AiAgentRecord, 'enabled'> & { enabled: number }>;

  return rows.map((r) => ({
    ...r,
    enabled: Boolean(r.enabled),
  }));
}

export function updateAiAgent(
  db: Db,
  id: string,
  updates: Partial<Pick<AiAgentRecord, 'enabled' | 'model' | 'command' | 'bashSample'>>,
): void {
  const fields: string[] = [];
  const params: Record<string, unknown> = { id };

  if (typeof updates.enabled === 'boolean') {
    fields.push('enabled = :enabled');
    params.enabled = updates.enabled ? 1 : 0;
  }
  if (typeof updates.model === 'string') {
    fields.push('model = :model');
    params.model = updates.model.trim();
  }
  if (typeof updates.command === 'string') {
    fields.push('command = :command');
    params.command = updates.command.trim();
  }
  if (typeof updates.bashSample === 'string') {
    fields.push('bash_sample = :bashSample');
    params.bashSample = updates.bashSample.trim();
  }

  if (fields.length === 0) return;

  db.prepare(`UPDATE ai_agents SET ${fields.join(', ')} WHERE id = :id`).run(params);
}
