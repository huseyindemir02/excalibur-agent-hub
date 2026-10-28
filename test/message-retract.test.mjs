import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const data = mkdtempSync(join(tmpdir(), 'hub-retract-test-'));
process.env.HUB_DATA = data;
process.env.HUB_NO_LISTEN = '1';
process.env.HUB_HUMAN = 'Hüseyin';
const port = 30000 + Math.floor(Math.random() * 20000);
process.env.HUB_PORT = String(port);
// Existing schema/rows must migrate without discarding their text or allowing old log records to be retracted.
const legacy = new DatabaseSync(join(data, 'hub.db'));
legacy.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', to_agent TEXT, topic TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL);
INSERT INTO messages (project, author, kind, text, created_at) VALUES ('qa','Leyla','note','historical mirrored log','2026-10-10T00:00:00Z'),('qa','Hüseyin','chat','historical own chat','2026-10-10T00:01:00Z');`);
legacy.close();
const { server } = await import('../server.mjs');
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${port}`;
const token = readFileSync(join(data, 'token'), 'utf8').trim();
const headers = { 'X-Hub-Token': token, 'Content-Type': 'application/json' };
const browserHeaders = { Cookie: `hub=${token}`, Origin: base, 'Content-Type': 'application/json' };
const request = (path, body, auth = headers) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: auth, body: body ? JSON.stringify(body) : undefined });
const add = async (text, extra = {}) => {
  const response = await request('/api/messages', { author: 'Leyla', project: 'qa', text, ...extra });
  assert.equal(response.status, 201); return response.json();
};
const retract = (id, as = 'Leyla', auth = headers) => request('/api/messages/retract', { id, as }, auth);
const cli = (...args) => new Promise(resolve => {
  const child = spawn(process.execPath, ['bin/hub', ...args], { env: { ...process.env, HUB_AGENT: 'Leyla' } });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  child.on('close', code => resolve({ code, output }));
});
try {
  await test('ownership, operator browser boundary and log sources are enforced on the server', async () => {
    const own = await add('own'); const other = await add('other', { author: 'Marslı' });
    const human = await add('operator', { author: 'Hüseyin' });
    const log = await add('mirrored line', { source: 'log' });
    assert.equal((await retract(other.id)).status, 403);
    assert.equal((await retract(human.id)).status, 403);
    assert.equal((await retract(human.id, 'Hüseyin')).status, 403);
    assert.equal((await retract(log.id)).status, 403);
    assert.equal((await retract(1)).status, 403);
    assert.equal((await retract(own.id, 'Hüseyin', browserHeaders)).status, 403);
    assert.equal((await retract(human.id, 'Hüseyin', { ...browserHeaders, Origin: 'https://other.test' })).status, 403);
    assert.equal((await retract(human.id, 'Hüseyin', browserHeaders)).status, 200);
    assert.equal((await retract(2, 'Hüseyin', browserHeaders)).status, 200);
    const result = await (await retract(own.id)).json();
    assert.equal(result.text, 'Bu mesaj geri alındı');
    assert.equal(result.retracted_by, 'Leyla'); assert.ok(result.retracted_at);
    const repeated = await (await retract(own.id)).json();
    assert.equal(repeated.retracted_at, result.retracted_at);
    assert.equal((await retract(0)).status, 422);
    assert.equal((await retract(99999)).status, 404);
    assert.equal((await request('/api/messages/retract', { id: own.id, as: 'Leyla' }, {})).status, 401);
  });
  await test('all read projections, quotes, files and reuse hide retracted content while audit remains', async () => {
    const upload = await fetch(base + '/api/files?as=Leyla&name=synthetic.txt', {
      method: 'POST', headers: { 'X-Hub-Token': token, 'Content-Type': 'application/octet-stream' }, body: 'synthetic attachment',
    });
    assert.equal(upload.status, 201); const file = await upload.json();
    const original = await add('PRIVATE-SYNTHETIC-TEXT', { files: [file.id], topic: 'PRIVATE-TOPIC', to: 'all' });
    const reply = await add('reply', { reply_to: original.id, author: 'Marslı', to: 'all' });
    const shared = await add('shared file', { files: [file.id] });
    const before = await request('/files/' + file.id); assert.equal(before.status, 200);
    assert.equal(before.headers.get('cache-control'), 'no-store');
    const controller = new AbortController();
    const stream = await fetch(base + '/api/stream', { headers, signal: controller.signal });
    const reader = stream.body.getReader(); await reader.read();
    await retract(original.id);
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /event: retract/); assert.ok(!event.includes('PRIVATE-SYNTHETIC-TEXT')); controller.abort();
    for (const path of ['/api/messages?project=qa', '/api/inbox?as=Excalibur', '/api/inbox?as=H%C3%BCseyin&personal=1']) {
      const rows = await (await request(path)).json(); const serialized = JSON.stringify(rows);
      assert.ok(!serialized.includes('PRIVATE-SYNTHETIC-TEXT'));
      assert.ok(!serialized.includes('PRIVATE-TOPIC'));
      if (rows.some(m => m.id === original.id)) assert.deepEqual(rows.find(m => m.id === original.id).files, []);
      if (rows.some(m => m.id === reply.id)) assert.equal(rows.find(m => m.id === reply.id).reply.text, 'Bu mesaj geri alındı');
      if (rows.some(m => m.id === shared.id)) assert.deepEqual(rows.find(m => m.id === shared.id).files, []);
    }
    assert.equal((await request('/files/' + file.id)).status, 404);
    assert.equal((await request('/api/messages', { author: 'Leyla', project: 'qa', text: 'reuse', files: [file.id] })).status, 422);
    const audit = new DatabaseSync(join(data, 'hub.db'));
    const stored = audit.prepare('SELECT text, retracted_by, retracted_at FROM messages WHERE id = ?').get(original.id);
    assert.equal(stored.text, 'PRIVATE-SYNTHETIC-TEXT'); assert.equal(stored.retracted_by, 'Leyla'); assert.ok(stored.retracted_at); audit.close();
  });
  await test('CLI retracts own messages, refuses other authors, and marks log/import sources', async () => {
    const own = await add('CLI own'); const other = await add('CLI other', { author: 'Marslı' });
    assert.equal((await cli('retract', String(own.id))).code, 0);
    assert.equal((await cli('retract', String(other.id))).code, 1);
    const logged = await cli('log', 'qa', 'Leyla · NOTE · test · synthetic log'); assert.equal(logged.code, 0);
    const id = Number(/^#(\d+)/.exec(logged.output)[1]);
    assert.equal((await cli('retract', String(id))).code, 1);
    const importPath = join(data, 'synthetic-log.md');
    writeFileSync(importPath, '- 2026-10-17 00:00 · Leyla · NOTE · test · imported log\n');
    assert.equal((await cli('import', 'qa', importPath)).code, 0);
    const rows = await (await request('/api/messages?project=qa')).json();
    const imported = rows.find(m => m.text.includes('imported log'));
    assert.equal(imported.source, 'log');
    assert.equal((await cli('retract', String(imported.id))).code, 1);
    // The operator retracts in the browser; the CLI holds only the shared token, so the server refuses it.
    const operatorMsg = await add('CLI operator', { author: 'Hüseyin' });
    const asOperator = await cli('retract', String(operatorMsg.id), '--as', 'Hüseyin');
    assert.equal(asOperator.code, 1);
    assert.match(asOperator.output, /Hub browser/);
  });
  await test('message reactions toggle, enforce operator browser guard, reject unsupported emojis, and clear on retraction', async () => {
    const target = await add('react target');
    // Unsupported emoji rejected
    assert.equal((await request('/api/messages/react', { id: target.id, as: 'Leyla', emoji: '<script>' })).status, 422);
    // Operator reaction requires browser cookie + same-origin (CLI token rejected)
    assert.equal((await request('/api/messages/react', { id: target.id, as: 'Hüseyin', emoji: '👍' })).status, 403);
    assert.equal((await request('/api/messages/react', { id: target.id, as: 'Hüseyin', emoji: '👍' }, { ...browserHeaders, Origin: 'https://evil.test' })).status, 403);
    // Valid reactions from operator browser and agent
    const r1 = await (await request('/api/messages/react', { id: target.id, as: 'Hüseyin', emoji: '👍' }, browserHeaders)).json();
    assert.deepEqual(r1.reactions, [{ emoji: '👍', count: 1, authors: ['Hüseyin'] }]);
    const r2 = await (await request('/api/messages/react', { id: target.id, as: 'Leyla', emoji: '👍' })).json();
    assert.deepEqual(r2.reactions, [{ emoji: '👍', count: 2, authors: ['Hüseyin', 'Leyla'] }]);
    // Toggle off
    const r3 = await (await request('/api/messages/react', { id: target.id, as: 'Leyla', emoji: '👍' })).json();
    assert.deepEqual(r3.reactions, [{ emoji: '👍', count: 1, authors: ['Hüseyin'] }]);
    // Retracting the message clears reactions and blocks new ones
    await retract(target.id);
    assert.equal((await request('/api/messages/react', { id: target.id, as: 'Leyla', emoji: '❤️' })).status, 409);
    const rows = await (await request('/api/messages?project=qa')).json();
    assert.deepEqual(rows.find(m => m.id === target.id).reactions, []);
  });
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(data, { recursive: true, force: true });
}
