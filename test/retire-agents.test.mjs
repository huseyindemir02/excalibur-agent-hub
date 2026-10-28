import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const data = mkdtempSync(join(tmpdir(), 'hub-retire-test-'));
process.env.HUB_DATA = data;
process.env.HUB_NO_LISTEN = '1';
process.env.HUB_HUMAN = 'Hüseyin';
const port = 30000 + Math.floor(Math.random() * 20000);
process.env.HUB_PORT = String(port);

// Test migration from legacy schema where agents table does not have retired column.
const legacy = new DatabaseSync(join(data, 'hub.db'));
legacy.exec(`CREATE TABLE agents (name TEXT PRIMARY KEY, color TEXT NOT NULL, tool TEXT, is_human INTEGER NOT NULL DEFAULT 0, last_seen TEXT);
INSERT INTO agents (name, color, tool, is_human, last_seen) VALUES
  ('Hüseyin', '#111827', NULL, 1, '2026-10-24T12:00:00Z'),
  ('Excalibur', '#2563eb', 'Claude Code', 0, '2026-10-24T12:00:00Z'),
  ('Leyla', '#16a34a', 'Codex', 0, '2026-10-24T12:00:00Z'),
  ('Qwen', '#ea580c', 'Bionic', 0, '2026-10-24T12:00:00Z');
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', to_agent TEXT, topic TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL);
INSERT INTO messages (project, author, kind, text, created_at) VALUES ('coordination', 'Qwen', 'chat', 'Qwen historical message', '2026-10-24T12:01:00Z');
`);
legacy.close();

const { server } = await import('../server.mjs');
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${port}`;
const token = readFileSync(join(data, 'token'), 'utf8').trim();
const headers = { 'X-Hub-Token': token, 'Content-Type': 'application/json' };

const request = (path, body, auth = headers) => fetch(base + path, {
  method: body ? 'POST' : 'GET',
  headers: auth,
  body: body ? JSON.stringify(body) : undefined,
});

const cli = (...args) => new Promise(resolve => {
  const child = spawn(process.execPath, ['bin/hub', ...args], {
    env: { ...process.env, HUB_AGENT: 'Excalibur' },
  });
  let output = '';
  child.stdout.on('data', x => output += x);
  child.stderr.on('data', x => output += x);
  child.on('close', code => resolve({ code, output }));
});

try {
  // Set Excalibur as coordinator for permission tests
  const coordRes = await request('/api/agents/profile', { name: 'Excalibur', role: 'coordinator' });
  assert.equal(coordRes.status, 200);

  await test('schema migration adds retired column and defaults existing agents to retired=0', async () => {
    const res = await request('/api/agents');
    assert.equal(res.status, 200);
    const agents = await res.json();
    assert.equal(agents.length, 4);
    for (const a of agents) {
      assert.equal(a.retired, 0);
    }
  });

  await test('retire authorization: only Hüseyin or coordinator can retire/unretire', async () => {
    // Non-coordinator agent (Leyla) attempts to retire Qwen -> 403 Forbidden
    const unauth = await request('/api/agents/retire', { as: 'Leyla', name: 'Qwen', retired: 1 });
    assert.equal(unauth.status, 403);
    const unauthErr = await unauth.json();
    assert.match(unauthErr.error, /only Hüseyin or the coordinator/i);

    // Operator cannot be retired -> 422
    const opRetire = await request('/api/agents/retire', { as: 'Excalibur', name: 'Hüseyin', retired: 1 });
    assert.equal(opRetire.status, 422);
    assert.match((await opRetire.json()).error, /operator cannot be retired/i);

    // Active coordinator cannot be retired while holding the role -> 422
    const coordRetire = await request('/api/agents/retire', { as: 'Hüseyin', name: 'Excalibur', retired: 1 });
    assert.equal(coordRetire.status, 422);
    assert.match((await coordRetire.json()).error, /cannot retire the active coordinator/i);
  });

  await test('retire → not in list, old messages preserved, posting rejected (403), unretire restores', async () => {
    // Populate usage for Qwen
    const db = new DatabaseSync(join(data, 'hub.db'));
    db.prepare(`INSERT OR REPLACE INTO agent_usage (agent, plan, windows, note, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      'Qwen', 'Local Qwen', JSON.stringify([{ label: '5 saatlik', percent_used: 10 }]), null, 'claude-app', '2026-10-24T12:00:00Z'
    );
    db.close();

    // Usage initially shows Qwen
    const initialUsage = await (await request('/api/usage')).json();
    assert.ok(initialUsage.some(u => u.agent === 'Qwen'));

    // 1. Coordinator retires Qwen
    const retRes = await request('/api/agents/retire', { as: 'Excalibur', name: 'Qwen', retired: 1 });
    assert.equal(retRes.status, 200);
    const retBody = await retRes.json();
    assert.equal(retBody.name, 'Qwen');
    assert.equal(retBody.retired, 1);

    // 2. GET /api/agents: Qwen is NOT in the active list
    const activeList = await (await request('/api/agents')).json();
    assert.equal(activeList.some(a => a.name === 'Qwen'), false, 'Retired agent must not appear in /api/agents');
    assert.equal(activeList.length, 3);

    // GET /api/usage: Qwen is omitted from usage limits
    const retiredUsage = await (await request('/api/usage')).json();
    assert.equal(retiredUsage.some(u => u.agent === 'Qwen'), false, 'Retired agent must not appear in /api/usage');

    // GET /api/agents?all=1: Qwen is present with retired=1
    const allList = await (await request('/api/agents?all=1')).json();
    const qwen = allList.find(a => a.name === 'Qwen');
    assert.ok(qwen);
    assert.equal(qwen.retired, 1);

    // 3. Historical messages remain preserved with author name
    const msgRes = await request('/api/messages?project=coordination');
    assert.equal(msgRes.status, 200);
    const msgs = await msgRes.json();
    const qwenMsg = msgs.find(m => m.author === 'Qwen');
    assert.ok(qwenMsg, 'Historical message from Qwen must exist');
    assert.equal(qwenMsg.text, 'Qwen historical message');

    // 4. POST /api/messages by retired agent is rejected with HTTP 403
    const postRes = await request('/api/messages', {
      author: 'Qwen',
      project: 'coordination',
      text: 'Trying to post while retired',
    });
    assert.equal(postRes.status, 403, 'Posting by retired agent must be rejected with 403');
    const postErr = await postRes.json();
    assert.match(postErr.error, /Qwen is retired; cannot post messages/i);

    // 5. Unretire restores the agent
    const unretRes = await request('/api/agents/retire', { as: 'Hüseyin', name: 'Qwen', retired: 0 });
    assert.equal(unretRes.status, 200);
    const unretBody = await unretRes.json();
    assert.equal(unretBody.retired, 0);

    // Qwen is back in /api/agents and /api/usage
    const restoredList = await (await request('/api/agents')).json();
    assert.ok(restoredList.some(a => a.name === 'Qwen'), 'Unretired agent must appear in /api/agents');
    const restoredUsage = await (await request('/api/usage')).json();
    assert.ok(restoredUsage.some(u => u.agent === 'Qwen'), 'Unretired agent must appear in /api/usage');

    // Posting now succeeds
    const postSuccess = await request('/api/messages', {
      author: 'Qwen',
      project: 'coordination',
      text: 'Posting successfully after unretire',
    });
    assert.equal(postSuccess.status, 201);
  });

  await test('CLI: hub retire and hub unretire commands operate correctly and enforce permissions', async () => {
    // CLI retire via coordinator (HUB_AGENT=Excalibur)
    const retCli = await cli('retire', 'Qwen');
    assert.equal(retCli.code, 0);
    assert.match(retCli.output, /retired: Qwen/);

    // hub who shows active agents only (Qwen omitted)
    const whoCli = await cli('who');
    assert.equal(whoCli.code, 0);
    assert.doesNotMatch(whoCli.output, /\bQwen\b/);

    // hub who --all shows Qwen with [retired] tag
    const whoAllCli = await cli('who', '--all');
    assert.equal(whoAllCli.code, 0);
    assert.match(whoAllCli.output, /Qwen \[retired\]/);

    // CLI unretire
    const unretCli = await cli('unretire', 'Qwen');
    assert.equal(unretCli.code, 0);
    assert.match(unretCli.output, /unretired: Qwen/);

    // hub who now shows Qwen again
    const whoRestored = await cli('who');
    assert.match(whoRestored.output, /\bQwen\b/);

    // Non-coordinator agent cannot retire via CLI
    const unauthCli = await new Promise(resolve => {
      const child = spawn(process.execPath, ['bin/hub', 'retire', 'Qwen'], {
        env: { ...process.env, HUB_AGENT: 'Leyla' },
      });
      let output = '';
      child.stdout.on('data', x => output += x);
      child.stderr.on('data', x => output += x);
      child.on('close', code => resolve({ code, output }));
    });
    assert.equal(unauthCli.code, 1);
    assert.match(unauthCli.output, /HTTP 403: only Hüseyin or the coordinator/i);
  });

} finally {
  server.close();
  rmSync(data, { recursive: true, force: true });
}
