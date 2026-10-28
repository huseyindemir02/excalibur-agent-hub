import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'hub-personal-test-'));
process.env.HUB_DATA = data;
process.env.HUB_NO_LISTEN = '1';
const port = 30000 + Math.floor(Math.random() * 20000);
process.env.HUB_PORT = String(port);
const { server, post, validateMessage } = await import('../server.mjs');
const add = (text, extra = {}) => post(validateMessage({ author: 'Luna', project: 'qa', text, ...extra }));
const own = add('My message', { author: 'Hüseyin' });
const expected = [
  add('**@Hüseyin** please check').id,
  add('(@HÜSEYİN), unicode mention').id,
  add('@herkes. hello').id,
  add('direct message', { to: 'Hüseyin' }).id,
  add('reply without mention', { reply_to: own.id }).id,
];
add('unrelated message');
add('agent broadcast without a mention', { to: 'all' });
add('@Hüseyinn prefix must not match');
add('@Hüseyin heartbeat', { kind: 'heartbeat' });
add('operator command for agents', { author: 'Hüseyin', kind: 'command' });
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const address = server.address();
const headers = { 'X-Hub-Token': readFileSync(join(data, 'token'), 'utf8').trim() };
const get = async path => {
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers });
  assert.equal(response.status, 200);
  return response.json();
};
try {
  await test('personal inbox includes unicode mentions, all, direct and replies, excludes routine noise and prefix matches', async () => {
    const rows = await get('/api/inbox?as=H%C3%BCseyin&personal=1&limit=500');
    assert.deepEqual(rows.map(m => m.id), expected);
    assert.equal(rows.at(-1).reply.author, 'Hüseyin');
  });
  await test('personal inbox keeps newest matching entries and respects since', async () => {
    const rows = await get('/api/inbox?as=H%C3%BCseyin&personal=1&limit=2');
    assert.deepEqual(rows.map(m => m.id), expected.slice(-2));
    const later = await get(`/api/inbox?as=H%C3%BCseyin&personal=1&since=${expected.at(-2)}`);
    assert.deepEqual(later.map(m => m.id), expected.slice(-1));
  });
  await test('agent unread retains operator instructions and operational heartbeats', async () => {
    const rows = await get('/api/inbox?as=Leyla&limit=500');
    assert.ok(rows.some(m => m.author === 'Hüseyin' && m.kind === 'command'));
    const beat = add('agent heartbeat', { to: 'Leyla', kind: 'heartbeat' });
    const fresh = await get('/api/inbox?as=Leyla&limit=500');
    assert.ok(fresh.some(m => m.id === beat.id));
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(data, { recursive: true, force: true });
}

test('settings no longer duplicates the agents panel button (Hüseyin #6447)', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /settingsAgentsBtn/);
});

test('on a phone the chat stays in the single grid track (no implicit second column)', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const phone = html.slice(html.indexOf('@media (max-width: 720px)'));
  assert.match(phone, /\.app > main \{ grid-column: 1; \}/);
});

test('the limit label and its value keep a gap even when the label is long', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /\.lim \.l \{ display: flex; justify-content: space-between; gap: 8px;/);
});
