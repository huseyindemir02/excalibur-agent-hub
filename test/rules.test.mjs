import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const data = mkdtempSync(join(tmpdir(), 'hub-rules-test-'));
process.env.HUB_DATA = data;
process.env.HUB_NO_LISTEN = '1';
process.env.HUB_HUMAN = 'Hüseyin';
const port = 30000 + Math.floor(Math.random() * 20000);
process.env.HUB_PORT = String(port);

// Initialize DB with agents
const initDb = new DatabaseSync(join(data, 'hub.db'));
initDb.exec(`
CREATE TABLE IF NOT EXISTS agents (name TEXT PRIMARY KEY, color TEXT NOT NULL, tool TEXT, is_human INTEGER NOT NULL DEFAULT 0, last_seen TEXT, retired INTEGER NOT NULL DEFAULT 0, role TEXT);
INSERT INTO agents (name, color, tool, is_human, last_seen, role) VALUES
  ('Hüseyin', '#111827', NULL, 1, '2026-10-26T12:00:00Z', NULL),
  ('Luna', '#a855f7', 'Claude Code', 0, '2026-10-26T12:00:00Z', 'coordinator'),
  ('Leyla', '#16a34a', 'Codex', 0, '2026-10-26T12:00:00Z', NULL),
  ('Nezle02', '#2563eb', 'Antigravity', 0, '2026-10-26T12:00:00Z', NULL);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', to_agent TEXT, topic TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, title TEXT, created_at TEXT NOT NULL);
INSERT INTO projects (slug, title, created_at) VALUES ('checkout-api', 'Checkout API', '2026-10-26T12:00:00Z');
`);
initDb.close();

const { server } = await import('../server.mjs');
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${port}`;
const token = readFileSync(join(data, 'token'), 'utf8').trim();
const headers = { 'X-Hub-Token': token, 'Content-Type': 'application/json' };

const request = (path, method = 'GET', body = null) => fetch(base + path, {
  method,
  headers,
  body: body ? JSON.stringify(body) : undefined,
});

const cli = (...args) => new Promise(resolve => {
  const child = spawn(process.execPath, ['bin/hub', ...args], {
    env: { ...process.env, HUB_AGENT: 'Luna', HUB_PORT: String(port) },
  });
  let output = '';
  child.stdout.on('data', x => output += x);
  child.stderr.on('data', x => output += x);
  child.on('close', code => resolve({ code, output }));
});

try {
  await test('rules table is auto-created and populated with default seed from RULES.md', async () => {
    const res = await request('/api/rules');
    assert.equal(res.status, 200);
    const rules = await res.json();
    assert.ok(Array.isArray(rules));
    assert.ok(rules.length >= 20, `expected at least 20 rules, got ${rules.length}`);
    assert.equal(rules[0].sort_order, 1);
    assert.equal(rules[0].category, 'How we work');
  });

  await test('rules authorization: non-coordinator agent cannot add, update, or delete rules', async () => {
    // Leyla (not coordinator, not human) -> 403
    const addRes = await request('/api/rules', 'POST', {
      as: 'Leyla',
      text: 'Unauthorized rule',
      category: 'Test',
    });
    assert.equal(addRes.status, 403);
    const addErr = await addRes.json();
    assert.match(addErr.error, /only Hüseyin or the coordinator/i);

    const updateRes = await request('/api/rules', 'PUT', {
      as: 'Leyla',
      id: 1,
      text: 'Tampered rule',
    });
    assert.equal(updateRes.status, 403);

    const delRes = await request('/api/rules', 'DELETE', {
      as: 'Leyla',
      id: 1,
    });
    assert.equal(delRes.status, 403);
  });

  await test('rules authorization: coordinator or Hüseyin can add, update, and delete rules', async () => {
    // Add rule by Luna (coordinator)
    const addRes = await request('/api/rules', 'POST', {
      as: 'Luna',
      text: 'Yeni eklenen koordinatör kuralı',
      category: 'Nasıl çalışırız',
    });
    assert.equal(addRes.status, 201);
    const newRule = await addRes.json();
    assert.equal(newRule.text, 'Yeni eklenen koordinatör kuralı');
    assert.equal(newRule.created_by, 'Luna');
    const newId = newRule.id;

    // Update rule by Hüseyin (human operator)
    const updateRes = await request('/api/rules', 'PUT', {
      as: 'Hüseyin',
      id: newId,
      text: 'Hüseyin tarafından güncellenen kural',
      category: 'Nasıl çalışırız',
      sort_order: 99,
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.text, 'Hüseyin tarafından güncellenen kural');
    assert.equal(updated.sort_order, 99);

    // Delete rule by Luna (coordinator)
    const delRes = await request('/api/rules', 'DELETE', {
      as: 'Luna',
      id: newId,
    });
    assert.equal(delRes.status, 200);
    const delJson = await delRes.json();
    assert.equal(delJson.ok, true);

    // Verify it is gone
    const verifyRes = await request('/api/rules');
    const all = await verifyRes.json();
    assert.ok(!all.some(r => r.id === newId));
  });

  await test('CLI: hub rules lists rules with categories', async () => {
    const { code, output } = await cli('rules');
    assert.equal(code, 0);
    assert.match(output, /How we work/);
    assert.match(output, /What we do not do/);
    assert.match(output, /How we talk/);
  });

  await test('CLI: hub rules add creates a new rule', async () => {
    const { code, output } = await cli('rules', 'add', 'CLI üzerinden eklenen test kuralı', '--category', 'Test');
    assert.equal(code, 0);
    assert.match(output, /eklendi/i);

    const { output: listOutput } = await cli('rules');
    assert.match(listOutput, /CLI üzerinden eklenen test kuralı/);
  });

  await test('CLI: hub say warns when posting a heartbeat to a project channel', async () => {
    const { code, output } = await cli('say', 'checkout-api', 'Test heartbeat', '--kind', 'heartbeat');
    assert.equal(code, 0);
    assert.match(output, /checkout-api is for project work/);
  });

  await test('project-scoped rules: can add project-specific rule and filter by project', async () => {
    const addRes = await request('/api/rules', 'POST', {
      as: 'Luna',
      text: 'Yalnız ERP için kural',
      category: 'Kanal',
      project: 'checkout-api',
    });
    assert.equal(addRes.status, 201);
    const erpRule = await addRes.json();
    assert.equal(erpRule.project, 'checkout-api');

    // Filtering by project includes global + checkout-api rules
    const filterRes = await request('/api/rules?project=checkout-api');
    assert.equal(filterRes.status, 200);
    const erpList = await filterRes.json();
    assert.ok(erpList.some(r => r.text === 'Yalnız ERP için kural'));

    // Filtering by another project excludes checkout-api rules
    const otherRes = await request('/api/rules?project=landing-page');
    const otherList = await otherRes.json();
    assert.ok(!otherList.some(r => r.text === 'Yalnız ERP için kural'));

    // CLI with project filter
    const { output } = await cli('rules', 'checkout-api');
    assert.match(output, /Yalnız ERP için kural/);
  });
} finally {
  server.close();
  try { rmSync(data, { recursive: true, force: true }); } catch {}
}
