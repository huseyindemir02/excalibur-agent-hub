import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const data = mkdtempSync(join(tmpdir(), 'hub-wait-test-'));
process.env.HUB_DATA = data;
process.env.HUB_NO_LISTEN = '1';
process.env.HUB_HUMAN = 'Operator';
const port = 30000 + Math.floor(Math.random() * 20000);
process.env.HUB_PORT = String(port);
const { server } = await import('../server.mjs');
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${port}`;
const token = readFileSync(join(data, 'token'), 'utf8').trim();
const headers = { 'X-Hub-Token': token, 'Content-Type': 'application/json' };
const db = new DatabaseSync(join(data, 'hub.db'));
const request = (path, body, extra = {}) => fetch(base + path, { headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, ...extra });
const add = async (extra = {}) => {
  const r = await request('/api/messages', { author: 'Marslı', project: 'qa', text: 'synthetic', ...extra });
  assert.equal(r.status, 201); return r.json();
};
const wait = (as, extra = {}, options = {}) => request('/api/wait?' + new URLSearchParams({ as, timeout: '1', ...extra }), null, options);
const cli = (as, ...args) => new Promise(resolve => {
  const child = spawn(process.execPath, ['bin/hub', ...args], { env: { ...process.env, HUB_AGENT: as, HUB_TIMEOUT_MS: '400' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
  child.on('close', code => resolve({ code, stdout, stderr }));
});
try {
  await test('wait validates authentication, agent, timeout and project before holding a connection', async () => {
    assert.equal((await wait('Leyla', {}, { headers: {} })).status, 401);
    for (const params of [{ timeout: '301' }, { timeout: '0' }, { timeout: 'NaN' }, { since: '-1' }, { project: '../qa' }, { timeout: '1.5' }]) {
      assert.equal((await wait('Leyla', params)).status, 422);
    }
    assert.equal((await wait('bad/name')).status, 422);
  });
  await test('a held wait ignores unrelated/own/other-project messages and returns when addressed', async () => {
    let finished = false;
    const pending = wait('Target', { project: 'qa', timeout: '3' }).then(async r => { finished = true; return r.json(); });
    await delay(80);
    await add({ text: 'unrelated' });
    await add({ author: 'Target', text: '@Target own' });
    await add({ project: 'other', to: 'Target' });
    await delay(80); assert.equal(finished, false);
    const target = await add({ to: 'Target' });
    assert.deepEqual((await pending).map(m => m.id), [target.id]);
  });
  await test('mentions, everyone and replies wake; operator messages wake only the coordinator', async () => {
    for (const extra of [{ text: '@Mention hello' }, { text: '@all hello' }, { text: '@herkes hello' }]) {
      const message = await add(extra);
      assert.ok((await (await wait('Mention')).json()).some(m => m.id === message.id));
    }
    const parent = await add({ author: 'ReplyTarget' });
    const reply = await add({ reply_to: parent.id });
    assert.ok((await (await wait('ReplyTarget')).json()).some(m => m.id === reply.id));
    await request('/api/agents/profile', { name: 'Coordinator', role: 'coordinator' });
    const human = await add({ author: 'Operator' });
    assert.deepEqual((await (await wait('Coordinator', { since: String(human.id - 1) })).json()).map(m => m.id), [human.id]);
    assert.deepEqual(await (await wait('Ordinary', { since: String(human.id - 1) })).json(), []);
  });
  await test('CLI timeout is silent exit 2; wait uses its requested duration instead of the ordinary request timeout', async () => {
    const r = await cli('NoMessages', 'wait', '--timeout', '1', '--project', 'empty');
    assert.equal(r.code, 2); assert.equal(r.stdout, ''); assert.equal(r.stderr, '');
    const pending = cli('SlowTarget', 'wait', '--timeout', '2', '--project', 'slow');
    await delay(700); const message = await add({ project: 'slow', to: 'SlowTarget' });
    const slow = await pending;
    assert.equal(slow.code, 0); assert.match(slow.stdout, new RegExp(`#${message.id} `));
    const bad = await cli('NoMessages', 'wait', '--timeout', '301');
    assert.equal(bad.code, 1); assert.match(bad.stderr, /--timeout/);
  });
  await test('project wait leaves shared marker untouched; unread still delivers both chats', async () => {
    writeFileSync(join(data, 'seen-Cursor.json'), JSON.stringify({ since: 0 }));
    const first = await add({ project: 'first', to: 'Cursor' });
    const second = await add({ project: 'second', to: 'Cursor' });
    const received = await cli('Cursor', 'wait', '--timeout', '1', '--project', 'second');
    assert.equal(received.code, 0); assert.match(received.stdout, new RegExp(`#${second.id} `));
    let state = JSON.parse(readFileSync(join(data, 'seen-Cursor.json')));
    assert.deepEqual(state, { since: 0 });
    const unread = await cli('Cursor', 'unread');
    assert.match(unread.stdout, new RegExp(`#${first.id} `));
    assert.match(unread.stdout, new RegExp(`#${second.id} `));
    assert.equal((await cli('Cursor', 'wait', '--timeout', '1')).code, 2);
    state = JSON.parse(readFileSync(join(data, 'seen-Cursor.json')));
    assert.equal(state.since, second.id);
  });
  await test('unfiltered wait preserves intervening operator, all and command messages for unread', async () => {
    const baseline = await add({ project: 'cursor-regression' });
    const marker = join(data, 'seen-Worker.json');
    const state = JSON.stringify({ since: baseline.id });
    writeFileSync(marker, state);
    const operator = await add({ author: 'Operator', text: 'General instruction' });
    const everyone = await add({ to: 'all', text: 'Broadcast instruction' });
    const command = await add({ author: 'Operator', kind: 'command', text: 'Command instruction' });
    const direct = await add({ to: 'Worker', text: 'Direct instruction' });
    const received = await cli('Worker', 'wait', '--timeout', '1');
    assert.equal(received.code, 0);
    assert.match(received.stdout, new RegExp(`#${direct.id} `));
    assert.doesNotMatch(received.stdout, new RegExp(`#${operator.id} `));
    assert.equal(readFileSync(marker, 'utf8'), state, 'wait must never acknowledge unread-only messages');
    const unread = await cli('Worker', 'unread');
    for (const message of [operator, everyone, command, direct]) assert.match(unread.stdout, new RegExp(`#${message.id} `));
    assert.deepEqual(JSON.parse(readFileSync(marker)), { since: direct.id });
    assert.equal((await cli('Worker', 'unread')).stdout.trim(), '(no new messages for Worker)');
  });
  await test('wait excludes retracted messages and tolerates a disconnected client', async () => {
    const m = await add({ author: 'Retractor', to: 'RetractTarget' });
    await request('/api/messages/retract', { as: 'Retractor', id: m.id });
    assert.deepEqual(await (await wait('RetractTarget', { since: String(m.id - 1) })).json(), []);
    const abort = new AbortController();
    const pending = wait('Disconnected', { timeout: '300', project: 'empty' }, { signal: abort.signal });
    await delay(80); abort.abort();
    await assert.rejects(pending, /abort/i);
    assert.equal((await request('/api/projects')).status, 200);
  });
  await test('claim warning is advisory, scoped, expires after two hours and closes on done/takeover', async () => {
    const claim = await add({ kind: 'claim', topic: 'work' });
    const duplicate = await add({ author: 'Leyla', kind: 'claim', topic: 'work' });
    assert.equal(duplicate.claim_warning.id, claim.id);
    assert.equal(duplicate.claim_warning.author, 'Marslı');
    assert.equal((await add({ project: 'other', kind: 'claim', topic: 'work' })).claim_warning, undefined);
    await add({ kind: 'claim', topic: 'own' });
    assert.equal((await add({ kind: 'claim', topic: 'own' })).claim_warning, undefined);
    const expired = await add({ kind: 'claim', topic: 'expired' });
    db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 7200001).toISOString(), expired.id);
    assert.equal((await add({ author: 'Leyla', kind: 'claim', topic: 'expired' })).claim_warning, undefined);
    for (const kind of ['done', 'takeover']) {
      await add({ kind: 'claim', topic: kind });
      await add({ kind, topic: kind });
      assert.equal((await add({ author: 'Leyla', kind: 'claim', topic: kind })).claim_warning, undefined);
    }
    await add({ kind: 'claim', topic: 'cli' });
    const result = await cli('Leyla', 'say', 'qa', 'Taking work', '--kind', 'claim', '--topic', 'cli');
    assert.equal(result.code, 0); assert.match(result.stderr, /⚠ cli .*Marslı/); assert.match(result.stdout, /Taking work/);
  });
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(data, { recursive: true, force: true });
}
