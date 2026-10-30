import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Stub servers only: temporary token, local test ports, never the live Hub.
const data = mkdtempSync(join(tmpdir(), 'hub-cli-errors-'));
writeFileSync(join(data, 'token'), 'a'.repeat(48) + '\n');
const cli = (port, ...args) => new Promise(resolve => {
  const child = spawn(process.execPath, ['bin/hub', ...args], { env: { ...process.env, HUB_DATA: data, HUB_PORT: String(port), HUB_AGENT: 'Leyla', HUB_TIMEOUT_MS: '400' } });
  let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x);
  child.on('close', code => resolve({ code, output }));
});
const stub = handler => new Promise(resolve => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const close = s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); });

try {
  await test('a stalled server is reported as a timeout, not as "not running"', async () => {
    const s = await stub(() => { /* never answers */ });
    const r = await cli(s.address().port, 'projects');
    await close(s);
    assert.equal(r.code, 1);
    assert.match(r.output, /did not answer \/api\/projects within 0\.4s/);
    assert.doesNotMatch(r.output, /not running/);
  });
  await test('a closed port is reported as connection refused', async () => {
    const s = await stub(() => {}); const { port } = s.address(); await close(s);
    const r = await cli(port, 'projects');
    assert.equal(r.code, 1);
    assert.match(r.output, /not running .*connection refused/);
  });
  await test('a disconnected long-poll exits 1 with a clear error rather than a silent timeout', async () => {
    const s = await stub(req => req.socket.destroy());
    const r = await cli(s.address().port, 'wait', '--timeout', '1');
    await close(s);
    assert.equal(r.code, 1);
    assert.match(r.output, /request \/api\/wait .*failed/);
  });
  await test('HTTP errors and non-JSON bodies keep their status', async () => {
    const s = await stub((req, res) => req.url.startsWith('/api/projects')
      ? (res.writeHead(502, { 'Content-Type': 'text/html' }), res.end('<h1>bad gateway</h1>'))
      : (res.writeHead(401, { 'Content-Type': 'application/json' }), res.end('{"error":"token required"}')));
    const port = s.address().port;
    const html = await cli(port, 'projects');
    const denied = await cli(port, 'who');
    await close(s);
    assert.match(html.output, /HTTP 502 from \/api\/projects: response is not JSON/);
    assert.match(denied.output, /HTTP 401: token required/);
  });
} finally {
  rmSync(data, { recursive: true, force: true });
}
