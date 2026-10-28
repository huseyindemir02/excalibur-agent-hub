import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

process.env.HUB_NO_LISTEN = '1';

test('settings: readConfig and writeConfig manage config.json properly', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-cfg-test-'));
  process.env.HUB_DATA = tmp;

  const { readConfig, writeConfig } = await import(`../server.mjs?test=${Date.now()}`);

  const initial = readConfig();
  assert.equal(initial.port, 7788);
  assert.equal(initial.lan, false);

  const updated = writeConfig({ port: 8899, lan: true });
  assert.equal(updated.port, 8899);
  assert.equal(updated.lan, true);

  const reRead = readConfig();
  assert.equal(reRead.port, 8899);
  assert.equal(reRead.lan, true);

  rmSync(tmp, { recursive: true, force: true });
});

test('settings: authorization and input validation for POST /api/config', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-cfg-auth-'));
  process.env.HUB_DATA = tmp;
  process.env.HUB_NO_LISTEN = '1';
  const port = 34500 + Math.floor(Math.random() * 5000);
  process.env.HUB_PORT = String(port);

  const { server, ensureAgent, readConfig } = await import(`../server.mjs?test=${Date.now()}`);

  await new Promise(r => server.listen(port, '127.0.0.1', r));

  const token = readFileSync(join(tmp, 'token'), 'utf8').trim();

  try {
    // 1. GET /api/config
    const getRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: { 'X-Hub-Token': token }
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.ok(typeof getBody.port === 'number');
    assert.ok(typeof getBody.lan === 'boolean');
    assert.ok(Array.isArray(getBody.localIps));
    assert.equal(getBody.operator, 'Operator');
    assert.ok(typeof getBody.version === 'string' && getBody.version.startsWith('2.0.0'));
    assert.equal(getBody.dataDir, tmp);

    // 1b. GET /excalibur.jpg serves JPEG icon (#6287, #6301)
    const iconRes = await fetch(`http://127.0.0.1:${port}/excalibur.jpg`);
    assert.equal(iconRes.status, 200);
    assert.equal(iconRes.headers.get('content-type'), 'image/jpeg');
    const iconBytes = new Uint8Array(await iconRes.arrayBuffer());
    assert.ok(iconBytes.length > 1000 && iconBytes[0] === 0xff && iconBytes[1] === 0xd8, 'Must return valid JPEG bytes');

    // 1c. Posting a message to an archived chat automatically unarchives it (#6299)
    await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token },
      body: JSON.stringify({ project: 'arch-test', author: 'Luna', kind: 'chat', text: 'initial' })
    });
    await fetch(`http://127.0.0.1:${port}/api/projects/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token },
      body: JSON.stringify({ slug: 'arch-test', archived: true })
    });
    let projs = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: { 'X-Hub-Token': token } })).json();
    assert.equal(projs.find(p => p.slug === 'arch-test')?.archived, 1);

    await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Token': token },
      body: JSON.stringify({ project: 'arch-test', author: 'Luna', kind: 'chat', text: 'reply brings it back' })
    });
    projs = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: { 'X-Hub-Token': token } })).json();
    assert.equal(projs.find(p => p.slug === 'arch-test')?.archived, 0, 'Posting to archived chat must unarchive it (#6299)');

    // 2. Unauthorized agent gets 403
    ensureAgent('RogueAgent');
    const unauthRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST',
      headers: { 'X-Hub-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'RogueAgent', port: 7799 })
    });
    assert.equal(unauthRes.status, 403);

    // 3. Invalid port gets 422
    const invalidPortRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST',
      headers: { 'X-Hub-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'Operator', port: 999999 })
    });
    assert.equal(invalidPortRes.status, 422);

    // 4. Valid update by Operator succeeds
    const validRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST',
      headers: { 'X-Hub-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ as: 'Operator', port: 7795, lan: true })
    });
    assert.equal(validRes.status, 200);
    const validBody = await validRes.json();
    assert.equal(validBody.ok, true);
    assert.equal(validBody.config.port, 7795);
    assert.equal(validBody.config.lan, true);
    assert.equal(validBody.restartRequired, true);

    const saved = readConfig();
    assert.equal(saved.port, 7795);
    assert.equal(saved.lan, true);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('settings: LAN mode allows requests with host header matching local LAN IP', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-cfg-lan-'));
  process.env.HUB_DATA = tmp;
  process.env.HUB_NO_LISTEN = '1';
  process.env.HUB_LAN = '1';
  const port = 35500 + Math.floor(Math.random() * 5000);
  process.env.HUB_PORT = String(port);

  const { server, getLocalIps } = await import(`../server.mjs?test=${Date.now()}`);
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const token = readFileSync(join(tmp, 'token'), 'utf8').trim();

  const httpReq = (hostHeader, path = '/api/config') => new Promise((resolve, reject) => {
    const req = createServer.name; // check import
    import('node:http').then(http => {
      const r = http.request({
        host: '127.0.0.1',
        port,
        path,
        headers: {
          'Host': hostHeader,
          'X-Hub-Token': token
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      r.on('error', reject);
      r.end();
    });
  });

  const ips = getLocalIps();
  try {
    if (ips.length > 0) {
      const lanHost = `${ips[0]}:${port}`;
      const res = await httpReq(lanHost);
      assert.equal(res.status, 200, `LAN host ${lanHost} should be allowed in LAN mode`);
    }

    // Host outside allowed list is rejected with 421
    const badRes = await httpReq(`evil.com:${port}`);
    assert.equal(badRes.status, 421, 'Arbitrary host must be rejected with 421');
  } finally {
    server.close();
    delete process.env.HUB_LAN;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('settings: CLI hub config and hub config set commands work properly', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-cfg-cli-'));
  process.env.HUB_DATA = tmp;
  process.env.HUB_NO_LISTEN = '1';
  const port = 36500 + Math.floor(Math.random() * 5000);
  process.env.HUB_PORT = String(port);

  const { server } = await import(`../server.mjs?test=${Date.now()}`);
  await new Promise(r => server.listen(port, '127.0.0.1', r));

  const runCli = (cliArgs) => new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [join(import.meta.dirname, '../bin/hub'), ...cliArgs], {
      env: { ...process.env, HUB_DATA: tmp, HUB_PORT: String(port), HUB_AGENT: 'Operator' }
    });
    let out = '', err = '';
    cp.stdout.on('data', d => out += d);
    cp.stderr.on('data', d => err += d);
    cp.on('close', code => resolve({ code, out, err }));
  });

  try {
    // 1. hub config (view)
    const viewRes = await runCli(['config']);
    assert.equal(viewRes.code, 0);
    assert.ok(viewRes.out.includes(`Çalışan Port: ${port}`));

    // 2. hub config set --port 7792 --lan true
    const setRes = await runCli(['config', 'set', '--port', '7792', '--lan', 'true']);
    assert.equal(setRes.code, 0);
    assert.ok(setRes.out.includes('port=7792'));
    assert.ok(setRes.out.includes('lan=açık'));

    // Check config.json file
    const cfg = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf8'));
    assert.equal(cfg.port, 7792);
    assert.equal(cfg.lan, true);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('settings: operator is configurable and reflected in /api/config', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-cfg-op-'));
  process.env.HUB_DATA = tmp;
  process.env.HUB_NO_LISTEN = '1';
  process.env.HUB_HUMAN = 'Demo Operator';
  const port = 37500 + Math.floor(Math.random() * 5000);
  process.env.HUB_PORT = String(port);

  const { server } = await import(`../server.mjs?test=${Date.now()}`);
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const token = readFileSync(join(tmp, 'token'), 'utf8').trim();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: { 'X-Hub-Token': token }
    });
    const body = await res.json();
    assert.equal(body.operator, 'Demo Operator');
  } finally {
    server.close();
    delete process.env.HUB_HUMAN;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('settings: upgrades preserve a registered operator; explicit config and environment take precedence', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  for (const [label,configured,environment,expected] of [
    ['legacy',null,null,'Existing Operator'],
    ['config','Configured Operator',null,'Configured Operator'],
    ['environment','Configured Operator','Environment Operator','Environment Operator'],
  ]) {
    const tmp=mkdtempSync(join(tmpdir(),'hub-operator-upgrade-'));
    const db=new DatabaseSync(join(tmp,'hub.db'));
    db.exec(`CREATE TABLE agents (name TEXT PRIMARY KEY, color TEXT NOT NULL, tool TEXT, is_human INTEGER NOT NULL DEFAULT 0, last_seen TEXT);
      INSERT INTO agents VALUES ('Existing Operator','#123456',NULL,1,'2026-01-01T00:00:00Z');`);db.close();
    if(configured) writeFileSync(join(tmp,'config.json'),JSON.stringify({operator:configured}));
    process.env.HUB_DATA=tmp;process.env.HUB_NO_LISTEN='1';
    if(environment)process.env.HUB_HUMAN=environment;else delete process.env.HUB_HUMAN;
    try {
      const {HUMAN}=await import(`../server.mjs?operator-upgrade=${label}`);
      assert.equal(HUMAN,expected);
      const audit=new DatabaseSync(join(tmp,'hub.db'));
      assert.equal(audit.prepare("SELECT COUNT(*) AS n FROM agents WHERE name='Existing Operator'").get().n,1);
      if(label==='legacy')assert.equal(audit.prepare('SELECT COUNT(*) AS n FROM agents').get().n,1,'no extra neutral operator on upgrade');
      audit.close();
    } finally {delete process.env.HUB_HUMAN;rmSync(tmp,{recursive:true,force:true})}
  }
});


test('settings: advertised phone addresses omit VPN and peer-to-peer interfaces', async () => {
  const tmp=mkdtempSync(join(tmpdir(),'hub-local-ips-'));
  process.env.HUB_DATA=tmp; process.env.HUB_NO_LISTEN='1';
  try {
    const {getLocalIps}=await import('../server.mjs?local-ips-filter');
    const address=(ip,internal=false,family='IPv4')=>({address:ip,internal,family});
    assert.deepEqual(getLocalIps({en0:[address('192.168.1.50')],utun4:[address('172.16.0.20')],wg0:[address('10.0.0.2')],tun0:[address('10.8.0.1')],awdl0:[address('169.254.1.2')],lo0:[address('127.0.0.1',true)],en1:[address('192.168.1.50'),address('fe80::1',false,'IPv6')]}),['192.168.1.50']);
    assert.deepEqual(getLocalIps({en1:[address('192.168.1.30')]}),['192.168.1.30'],'wired Ethernet remains usable');
  } finally {rmSync(tmp,{recursive:true,force:true})}
});
