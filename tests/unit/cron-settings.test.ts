import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeCronSettings, mountCronSettingsRoutes, validateCronSettingsUpdate } from '../../src/presentation/cronSettingsRoute.js';

test('legacy cron settings retain existing values and receive safe independent defaults', () => {
  const settings = mergeCronSettings({ dreams_schedule: '0 19 * * *', dreams_enabled: true, dreams_provider: 'openai' });
  assert.equal(settings.dreams_schedule, '0 19 * * *');
  assert.equal(settings.dreams_enabled, true);
  assert.equal(settings.dreams_provider, 'openai');
  assert.equal(settings.timezone, 'UTC');
  assert.equal(settings.reconciliation_enabled, true);
  assert.equal(settings.reconciliation_schedule, '*/5 * * * *');
});

test('cron settings preserve an optional tenant and project scope', () => {
  const settings = mergeCronSettings({
    tenant_id: 'canary-tenant',
    project_id: 'canonical-project-id',
    project: 'platform-display-name',
  });
  assert.equal(settings.tenant_id, 'canary-tenant');
  assert.equal(settings.project_id, 'canonical-project-id');
  assert.equal(settings.project, 'platform-display-name');
  assert.equal(mergeCronSettings({}).tenant_id, undefined);
  assert.equal(mergeCronSettings({}).project_id, undefined);
  assert.equal(mergeCronSettings({}).project, undefined);
});

test('settings reject invalid cron syntax, timezone, and boolean flags as one atomic patch', () => {
  assert.deepEqual(validateCronSettingsUpdate({ dreams_schedule: '70 25 * * *' }).valid, false);
  assert.equal(validateCronSettingsUpdate({ timezone: 'Mars/Olympus' }).valid, false);
  assert.equal(validateCronSettingsUpdate({ reconciliation_enabled: 'yes' }).valid, false);
  assert.equal(validateCronSettingsUpdate({ tenant_id: '' }).valid, false);
  assert.equal(validateCronSettingsUpdate({ project_id: 42 }).valid, false);
  assert.equal(validateCronSettingsUpdate({
    dreams_schedule: '0 19 * * *',
    reconciliation_schedule: '*/5 * * * *',
    timezone: 'Asia/Jakarta',
    dreams_enabled: false,
    reconciliation_enabled: true,
    tenant_id: 'canary-tenant',
    project_id: 'canonical-project-id',
    project: 'platform-display-name',
  }).valid, true);
});

function cronSettingsPutHandler(): (req: any, res: any, next: (error?: unknown) => void) => Promise<void> {
  let putHandlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown> = [];
  const app = {
    get: () => undefined,
    put: (_path: string, ...handlers: Array<(req: any, res: any, next: (error?: unknown) => void) => unknown>) => {
      putHandlers = handlers;
    },
  };
  mountCronSettingsRoutes(app as never);
  const handler = putHandlers.at(-1);
  assert.ok(handler, 'PUT handler should be registered');
  return handler as (req: any, res: any, next: (error?: unknown) => void) => Promise<void>;
}

async function invokeCronSettingsPut(auth: { uid: string; tier: string; role?: string } | undefined, body: unknown) {
  const handler = cronSettingsPutHandler();
  const response: { statusCode: number; body?: unknown } = { statusCode: 200 };
  const res = {
    status(statusCode: number) { response.statusCode = statusCode; return this; },
    json(value: unknown) { response.body = value; return this; },
  };
  await handler({ auth, body }, res, (error) => { if (error) throw error; });
  return response;
}

test('global cron settings reject ordinary tenants before touching the settings file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeatlas-cron-auth-'));
  const settingsPath = join(dir, 'cron-settings.json');
  const originalSettings = JSON.stringify({ reconciliation_enabled: true, updated_at: 'before-denial' });
  const previousPath = process.env.CRON_SETTINGS_PATH;
  process.env.CRON_SETTINGS_PATH = settingsPath;
  try {
    await writeFile(settingsPath, originalSettings, { mode: 0o600 });
    const response = await invokeCronSettingsPut({ uid: 'tenant-a', tier: 'enterprise', role: 'user' }, { reconciliation_enabled: false });
    assert.equal(response.statusCode, 403);
    assert.equal(await readFile(settingsPath, 'utf8'), originalSettings);
  } finally {
    if (previousPath === undefined) delete process.env.CRON_SETTINGS_PATH;
    else process.env.CRON_SETTINGS_PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('global cron settings accept uid, tier, or role admin and persist the patch', async (t) => {
  for (const auth of [
    { uid: 'admin', tier: 'enterprise' },
    { uid: 'tenant-role-admin', tier: 'enterprise', role: 'admin' },
    { uid: 'tenant-tier-admin', tier: 'admin', role: 'user' },
  ]) {
    await t.test(`${auth.uid} (${auth.role ?? auth.tier})`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'codeatlas-cron-admin-'));
      const settingsPath = join(dir, 'cron-settings.json');
      const previousPath = process.env.CRON_SETTINGS_PATH;
      process.env.CRON_SETTINGS_PATH = settingsPath;
      try {
        const response = await invokeCronSettingsPut(auth, { reconciliation_enabled: false });
        assert.equal(response.statusCode, 200);
        const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as { reconciliation_enabled: boolean };
        assert.equal(persisted.reconciliation_enabled, false);
      } finally {
        if (previousPath === undefined) delete process.env.CRON_SETTINGS_PATH;
        else process.env.CRON_SETTINGS_PATH = previousPath;
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test('cron settings route persists and serializes optional tenant and project scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codeatlas-cron-scope-'));
  const settingsPath = join(dir, 'cron-settings.json');
  const previousPath = process.env.CRON_SETTINGS_PATH;
  process.env.CRON_SETTINGS_PATH = settingsPath;
  try {
    const response = await invokeCronSettingsPut(
      { uid: 'admin', tier: 'enterprise' },
      { tenant_id: 'canary-tenant', project_id: 'canonical-project-id', project: 'platform-display-name' },
    );
    assert.equal(response.statusCode, 200);
    const serialized = (response.body as { settings: { tenant_id?: string; project_id?: string; project?: string } }).settings;
    assert.equal(serialized.tenant_id, 'canary-tenant');
    assert.equal(serialized.project_id, 'canonical-project-id');
    assert.equal(serialized.project, 'platform-display-name');
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as { tenant_id?: string; project_id?: string; project?: string };
    assert.equal(persisted.tenant_id, 'canary-tenant');
    assert.equal(persisted.project_id, 'canonical-project-id');
    assert.equal(persisted.project, 'platform-display-name');
  } finally {
    if (previousPath === undefined) delete process.env.CRON_SETTINGS_PATH;
    else process.env.CRON_SETTINGS_PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
