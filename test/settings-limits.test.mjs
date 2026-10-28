import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

// Temporary data dir and test ports only — never the live Hub.
process.env.HUB_NO_LISTEN = '1';
const tmp = mkdtempSync(join(tmpdir(), 'hub-limits-'));
process.env.HUB_DATA = tmp;
const port = 40500 + Math.floor(Math.random() * 5000);
process.env.HUB_PORT = String(port);
const { server, validateMessage, validateSchedule, readConfig } = await import(`../server.mjs?limits=${Date.now()}`);
await new Promise(r => server.listen(port, '127.0.0.1', r));
const token = readFileSync(join(tmp, 'token'), 'utf8').trim();
const call = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: body ? 'POST' : 'GET', headers: { 'X-Hub-Token': token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
});
const cli = (env, ...args) => new Promise(resolve => {
  const cp = spawn(process.execPath, [join(import.meta.dirname, '../bin/hub'), ...args], { env: { ...process.env, HUB_DATA: tmp, HUB_PORT: String(port), HUB_AGENT: 'Leyla', ...env } });
  let out = ''; cp.stdout.on('data', d => out += d); cp.stderr.on('data', d => out += d);
  cp.on('close', code => resolve({ code, out }));
});

try {
  await test('limits: empty and too-long messages get different, clear errors', async () => {
    assert.equal(validateMessage({ author: 'Leyla', project: 'qa', text: '' }), 'text or file required, max 8000 chars');
    assert.equal(typeof validateMessage({ author: 'Leyla', project: 'qa', text: 'x'.repeat(8000) }), 'object');
    const err = validateMessage({ author: 'Leyla', project: 'qa', text: 'x'.repeat(8001) });
    assert.equal(err, 'message is 8001 characters; the limit is 8000. Send the text as a file: hub say qa "<short summary>" --file <path>');
    const res = await call('/api/messages', { author: 'Leyla', project: 'qa', text: 'y'.repeat(9000) });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /message is 9000 characters; the limit is 8000/);
  });

  await test('limits: GET /api/config publishes maxText and the default advisory schedule', async () => {
    const cfg = await (await call('/api/config')).json();
    assert.equal(cfg.maxText, 8000);
    assert.deepEqual(cfg.agentSchedule, { checkMinutes: 30, heartbeatMinutes: 60, advisory: true, updatedAt: null });
  });

  await test('limits: schedule validation (ranges, heartbeat >= check, auth) and no restart', async () => {
    assert.match(validateSchedule({ checkMinutes: 4 }), /checkMinutes must be a whole number of minutes between 5 and 240/);
    assert.match(validateSchedule({ heartbeatMinutes: 481 }), /between 15 and 480/);
    assert.match(validateSchedule({ checkMinutes: 12.5 }), /whole number/);
    assert.match(validateSchedule({ checkMinutes: 90, heartbeatMinutes: 60 }), /heartbeatMinutes \(60\) must be at least checkMinutes \(90\)/);
    assert.deepEqual(validateSchedule({ checkMinutes: 30 }), {}, 'unchanged values do not bump updatedAt');

    const denied = await call('/api/config', { as: 'Rogue', checkMinutes: 20 });
    assert.equal(denied.status, 403);
    const bad = await call('/api/config', { as: 'Operator', checkMinutes: 200 });
    assert.equal(bad.status, 422, 'check 200 > default heartbeat 60');
    assert.equal(readConfig().checkMinutes, undefined, 'rejected values are not stored');

    const ok = await call('/api/config', { as: 'Operator', port, lan: false, checkMinutes: '20', heartbeatMinutes: 45 });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.restartRequired, false, 'schedule needs no restart');
    assert.equal(body.agentSchedule.checkMinutes, 20);
    assert.equal(body.agentSchedule.heartbeatMinutes, 45);
    assert.ok(Date.parse(body.agentSchedule.updatedAt));
    const cfg = await (await call('/api/config')).json();
    assert.deepEqual(cfg.agentSchedule, body.agentSchedule);
  });

  await test('limits: hub schedule prints the published values and the advisory note', async () => {
    const r = await cli({}, 'schedule');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /every 20 min/);
    assert.match(r.out, /every 45 min/);
    assert.match(r.out, /set your own timer/);
  });

  await test('limits: schedule CLI honors explicit language before HUB_LANG and rejects unknown languages', async () => {
    const tr = await cli({ HUB_LANG: 'en' }, 'schedule', '--lang', 'tr');
    assert.equal(tr.code, 0, tr.out);
    assert.match(tr.out, /her 20 dk/);
    assert.doesNotMatch(tr.out, /Advisory/);
    const ja = await cli({ HUB_LANG: 'ja' }, 'schedule');
    assert.equal(ja.code, 0, ja.out);
    assert.match(ja.out, /20分/);
    const bad = await cli({}, 'schedule', '--lang', 'invalid');
    assert.equal(bad.code, 1);
    assert.match(bad.out, /unsupported language/);
  });

  await test('limits: hub say refuses over-8000 text before any request', async () => {
    let hits = 0;
    const stub = createServer((req, res) => { hits++; res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{}'); });
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    const r = await cli({ HUB_PORT: String(stub.address().port) }, 'say', 'qa', 'z'.repeat(8001));
    await new Promise(r => stub.close(r));
    assert.equal(r.code, 1);
    assert.equal(hits, 0, 'nothing is sent or truncated');
    assert.match(r.out, /8000 karakteri geçtin \(8001\)\. Metni dosya olarak gönder: hub say qa "<kısa özet>" --file <yol>/);
    assert.match(r.out, /message is 8001 characters; the limit is 8000/);
  });

  await test('limits: composer has a near-limit counter, no maxlength, and tooLong in all languages', () => {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.match(html, /id="charCount"[^>]*hidden/);
    assert.doesNotMatch(/<textarea id="text"[^>]*>/.exec(html)[0], /maxlength/);
    const block = /\/\/ hub-pure:start[^\n]*\n([\s\S]*?)\n\s*\/\/ hub-pure:end/.exec(html)[1];
    const hub = new Function(`${block}\nreturn hubPure;`)();
    for (const lang of ['tr', 'en', 'ja', 'ar', 'zh']) {
      const msg = hub.t('tooLong', lang, { n: 8123, max: 8000 });
      assert.ok(msg.includes('8123') && msg.includes('8000') && msg.includes('--file'), `${lang}: ${msg}`);
      assert.doesNotMatch(hub.t('scheduleDesc', lang), /\{/);
    }
  });
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}
