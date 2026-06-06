import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { app } from '../../src/presentation/httpServer.js';

describe('MCP Auto-Scan & Database Sync Integration', () => {
  let server: http.Server;
  let port: number;
  const testProjectDir = path.join(process.cwd(), 'tests', 'mock_index_project');
  const apiKeyValue = 'test-integration-api-key';

  // Backup env variables
  const origApiKey = process.env.CODEATLAS_API_KEY;
  const origMultiTenant = process.env.CODEATLAS_MULTI_TENANT;
  const origProjectsRoot = process.env.CODEATLAS_PROJECTS_ROOT;

  before(async () => {
    process.env.CODEATLAS_API_KEY = apiKeyValue;
    process.env.CODEATLAS_MULTI_TENANT = 'false'; // single tenant mode for simpler pathing
    
    // Create mock client project directory
    if (fs.existsSync(testProjectDir)) {
      fs.rmSync(testProjectDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(testProjectDir, '.codeatlas'), { recursive: true });
    fs.writeFileSync(path.join(testProjectDir, 'index.ts'), 'export function hello() { console.log("hello world integration test"); }');

    // Start local express server
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          port = address.port;
        }
        resolve();
      });
    });
  });

  after(async () => {
    process.env.CODEATLAS_API_KEY = origApiKey;
    process.env.CODEATLAS_MULTI_TENANT = origMultiTenant;
    process.env.CODEATLAS_PROJECTS_ROOT = origProjectsRoot;

    // Stop local server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Clean up test directories
    if (fs.existsSync(testProjectDir)) {
      fs.rmSync(testProjectDir, { recursive: true, force: true });
    }
    const syncDir = path.join(process.cwd(), 'projects', 'mock_index_project');
    if (fs.existsSync(syncDir)) {
      fs.rmSync(syncDir, { recursive: true, force: true });
    }
  });

  test('should accept sync payload from API call and store local analysis', async () => {
    const mockAnalysisPayload = {
      projectName: 'mock_index_project',
      analysis: {
        totalFilesAnalyzed: 42,
        totalFilesSkipped: 3,
        entityCounts: {
          modules: 5,
          functions: 20,
          classes: 2,
          dependencies: 15,
          circularDeps: 0,
          deadCode: 0
        },
        graph: {
          nodes: [{ id: 'file1.ts', label: 'file1.ts', type: 'module' }],
          links: []
        },
        insights: []
      }
    };

    const res = await fetch(`http://localhost:${port}/api/projects/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKeyValue
      },
      body: JSON.stringify(mockAnalysisPayload)
    });

    assert.strictEqual(res.status, 200, 'Sync API should return 200 OK');
    const body = await res.json();
    assert.strictEqual(body.success, true);
    
    // Verify file is correctly written to disk on server-side
    const expectedFilePath = path.join(process.cwd(), 'projects', 'mock_index_project', '.codeatlas', 'analysis.json');
    assert.ok(fs.existsSync(expectedFilePath), 'Server should write analysis file to disk');
    
    const savedContent = JSON.parse(fs.readFileSync(expectedFilePath, 'utf-8'));
    assert.strictEqual(savedContent.totalFilesAnalyzed, 42);
    assert.strictEqual(savedContent.entityCounts.functions, 20);
  });

  test('E2E: Client should automatically index active workspace on startup and sync to Server', async () => {
    // We launch the client MCP process using child_process.spawn
    let clientBin = path.resolve(process.cwd(), '..', 'codeatlas-mcp-enterprise', 'dist', 'index.js');

    if (!fs.existsSync(clientBin)) {
      console.warn(`⚠️ Client build output dist/index.js not found at ${clientBin}. Skipping E2E startup sync test.`);
      return;
    }

    const clientProc = spawn('node', [clientBin], {
      cwd: testProjectDir,
      env: {
        ...process.env,
        CODEATLAS_API_KEY: apiKeyValue,
        CODEATLAS_API_URL: `http://localhost:${port}`,
        CODEATLAS_PROJECT_DIR: testProjectDir
      }
    });

    let clientExited = false;
    let clientExitCode: number | null = null;
    clientProc.on('exit', (code) => {
      clientExited = true;
      clientExitCode = code;
    });

    let stderrOutput = '';
    clientProc.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });

    // Wait for the sync to complete and server to receive and save the telemetry file
    const serverSyncPath = path.join(process.cwd(), 'projects', 'mock_index_project', '.codeatlas', 'analysis.json');
    
    const success = await new Promise<boolean>((resolve) => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        if (clientExited && clientExitCode !== 0) {
          clearInterval(interval);
          resolve(false);
        }
        if (fs.existsSync(serverSyncPath)) {
          clearInterval(interval);
          resolve(true);
        } else if (Date.now() - startTime > 10000) { // 10s timeout
          clearInterval(interval);
          resolve(false);
        }
      }, 200);
    });

    // Cleanup client process
    if (!clientExited) {
      clientProc.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 200));
      if (!clientExited) {
        clientProc.kill('SIGKILL');
      }
    }

    assert.ok(success, `Client failed to sync active workspace. Exit code: ${clientExitCode}. Client stderr output:\n${stderrOutput}`);
    
    // Verify content written on server
    const savedServerData = JSON.parse(fs.readFileSync(serverSyncPath, 'utf-8'));
    assert.ok(savedServerData.totalFilesAnalyzed > 0, 'Should have analyzed files');
    assert.ok(savedServerData.entityCounts.functions > 0, 'Should have found functions');
  });
});
