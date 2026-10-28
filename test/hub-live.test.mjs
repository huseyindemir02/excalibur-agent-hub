import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The UI's DOM-free helpers live between hub-pure markers in public/index.html; no server or data dir is used.
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const block = /\/\/ hub-pure:start[^\n]*\n([\s\S]*?)\n\s*\/\/ hub-pure:end/.exec(html)[1];
const hub = new Function(`${block}\nreturn hubPure;`)();
const ME = 'Hüseyin';
const msg = (id, extra = {}) => ({ id, project: 'qa', author: 'Luna', kind: 'chat', to_agent: null, text: 'hello', reply: null, ...extra });

test('bell counts mentions, @herkes/@all, direct messages and replies to the operator', () => {
  for (const m of [
    msg(1, { text: '**@Hüseyin** please check' }), msg(2, { text: '(@HÜSEYİN), case and dotted İ' }),
    msg(3, { text: '@herkes. hello' }), msg(4, { text: 'ping @all', to_agent: 'all' }),
    msg(5, { to_agent: ME }), msg(6, { reply: { id: 9, author: ME, text: 'q' } }),
  ]) assert.equal(hub.concerns(m, ME), true, m.text);
});

test('bell ignores other agents, bare --to all, heartbeats, own and retracted messages', () => {
  for (const m of [
    msg(1, { text: 'unrelated' }), msg(2, { text: 'for @Leyla', to_agent: 'Leyla' }), msg(3, { to_agent: 'all', text: 'NOTE broadcast' }),
    msg(4, { text: '@Hüseyinn prefix' }), msg(5, { text: 'mail huseyin@example.test' }), msg(6, { kind: 'heartbeat', text: '@Hüseyin alive' }),
    msg(7, { author: ME, text: '@herkes from me' }), msg(8, { retracted_at: '2026-10-20T00:00:00Z', text: 'Bu mesaj geri alındı' }),
    msg(9, { reply: { id: 1, author: 'Leyla', text: 'q' } }),
  ]) assert.equal(hub.concerns(m, ME), false, m.text);
});

test('seen watermark: first visit marks history read, stored value is respected', () => {
  const items = [msg(3), msg(7), msg(12)];
  assert.equal(hub.initialSeen(null, items), 12);
  assert.equal(hub.unseen(items, hub.initialSeen(null, items)), 0);
  assert.equal(hub.initialSeen('7', items), 7);
  assert.equal(hub.unseen(items, 7), 1);
  assert.equal(hub.initialSeen('0', items), 0);
  assert.equal(hub.initialSeen('garbage', items), 0);
});

test('viewing a chat advances the watermark only up to the first unseen item elsewhere', () => {
  const items = [msg(5, { project: 'a' }), msg(8, { project: 'a' }), msg(10, { project: 'b' }), msg(11, { project: 'a' })];
  assert.equal(hub.seenAfterView(items, 4, 'a'), 8);
  assert.equal(hub.seenAfterView(items, 4, 'b'), 4);
  assert.equal(hub.seenAfterView(items, 10, 'a'), 11);
  assert.equal(hub.seenAfterView(items, 11, 'a'), 11);
});

test('a live message moves its chat up, keeps pinned chats first and adds unknown chats', () => {
  const list = [
    { slug: 'pin', pinned: 1, archived: 0, last_id: 1, count: 1 }, { slug: 'erp', pinned: 0, archived: 0, last_id: 50, count: 9 },
    { slug: 'hr', pinned: 0, archived: 1, last_id: 40, count: 4 }, { slug: 'empty', pinned: 0, archived: 0, last_id: null, count: 0 },
  ];
  assert.deepEqual(hub.sortProjects(list).map(p => p.slug), ['pin', 'erp', 'hr', 'empty']);
  const moved = hub.touchProject(list, msg(51, { project: 'hr' }));
  assert.deepEqual(moved.map(p => p.slug), ['pin', 'hr', 'erp', 'empty']);
  assert.equal(moved.find(p => p.slug === 'hr').count, 5);
  assert.equal(moved.find(p => p.slug === 'hr').archived, 0, 'new message in archived chat must unarchive it (#6299)');
  assert.deepEqual(hub.touchProject(moved, msg(52, { project: 'new' })).map(p => p.slug), ['pin', 'new', 'hr', 'erp', 'empty']);
  assert.equal(list[2].last_id, 40, 'input list is not mutated');
});
