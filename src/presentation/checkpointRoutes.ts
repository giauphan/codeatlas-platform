import type express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { rejectArrayParams } from '../middleware/validation.js';
import { SessionCheckpointService, type CheckpointWrite } from '../services/sessionCheckpointService.js';

function validScope(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(value);
}

export function registerCheckpointRoutes(app: express.Application): void {
  app.get('/api/dreams/checkpoints/latest', authMiddleware, rejectArrayParams('project_id'), async (req, res) => {
    if (!validScope(req.query.project_id)) return res.status(400).json({ success: false, retrieval_status: 'backend_error', reason_code: 'invalid_project_id' });
    try {
      const checkpoint = await SessionCheckpointService.latest(req.query.project_id);
      return res.json({ success: true, retrieval_status: checkpoint ? 'ok' : 'empty', checkpoint });
    } catch {
      return res.status(500).json({ success: false, retrieval_status: 'backend_error', reason_code: 'checkpoint_read_failed' });
    }
  });

  app.post('/api/dreams/checkpoints', authMiddleware, async (req, res) => {
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ success: false, reason_code: 'invalid_checkpoint' });
    const data = body as Record<string, unknown>;
    if (!validScope(data.project_id) || !validScope(data.session_id) || !Array.isArray(data.source_event_ids) || data.source_event_ids.some(id => typeof id !== 'string')) return res.status(400).json({ success: false, reason_code: 'invalid_checkpoint_scope' });
    const fields = ['active_task', 'completed', 'decisions', 'blockers', 'next_actions'] as const;
    for (const key of fields) {
      const value = data[key];
      if (value === undefined) continue;
      if (key === 'active_task' ? typeof value !== 'string' : !Array.isArray(value) || value.some(item => typeof item !== 'string')) return res.status(400).json({ success: false, reason_code: 'invalid_checkpoint_field' });
    }
    const input: CheckpointWrite = {
      projectId: data.project_id,
      sessionId: data.session_id,
      sourceEventIds: data.source_event_ids as string[],
      activeTask: data.active_task as string | undefined,
      completed: data.completed as string[] | undefined,
      decisions: data.decisions as string[] | undefined,
      blockers: data.blockers as string[] | undefined,
      nextActions: data.next_actions as string[] | undefined,
    };
    try {
      const checkpoint = await SessionCheckpointService.save(input);
      return res.json({ success: true, status: 'stored', persisted: true, checkpoint });
    } catch {
      return res.status(400).json({ success: false, status: 'rejected', persisted: false, reason_code: 'unsupported_checkpoint_evidence' });
    }
  });
}
