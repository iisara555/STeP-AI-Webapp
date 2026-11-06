import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { provisionTestQuota } from './support/quota.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('production gateway refuses startup before touching data, even with a complete configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'step-gateway-entry-'));
  const data = join(root, 'data');
  try {
    const child = spawnSync('npm', ['run', 'gateway'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        STEP_DATA_ROOT: data,
        STEP_INVITES_FILE: join(root, 'invites.txt'),
        STEP_ALLOWED_DOMAINS: 'example.test',
        STEP_ADMINS: 'admin@example.test',
        STEP_QUOTA_WORKSPACES: '10',
        STEP_AI_BASE_URL: 'http://127.0.0.1:1/v1',
        STEP_AI_MODEL: 'synthetic',
        STEP_APP_ORIGIN: 'http://localhost:3000',
        STEP_GOOGLE_CLIENT_ID: 'synthetic',
      },
    });
    assert.equal(child.error, undefined);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /#57/);
    assert.match(child.stderr, /isolation/i);
    assert.equal(existsSync(data), false, 'startup must not create the data root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a provisioned root and unsafe-looking environment settings cannot bypass the refusal', () => {
  const root = mkdtempSync(join(tmpdir(), 'step-gateway-provisioned-'));
  try {
    provisionTestQuota(root, 10);
    const before = readdirSync(root).sort();
    const child = spawnSync('npm', ['run', 'gateway'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        STEP_DATA_ROOT: root,
        STEP_QUOTA_WORKSPACES: '10',
        STEP_ALLOW_UNSAFE: '1',
        STEP_SYNTHETIC_ONLY: '1',
      },
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /#57/);
    assert.deepEqual(readdirSync(root).sort(), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
