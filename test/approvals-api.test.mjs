import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const data = mkdtempSync(join(tmpdir(), 'hub-approvals-'));
process.env.HUB_HUMAN = 'Demo Operator';
process.env.HUB_DATA = data; process.env.HUB_NO_LISTEN = '1';
const port = 32000 + Math.floor(Math.random() * 20000); process.env.HUB_PORT = String(port);
const { server } = await import('../server.mjs');
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${port}`;
const token = readFileSync(join(data, 'token'), 'utf8').trim();
const agent = {'X-Hub-Token':token, 'Content-Type':'application/json'};
const browser = {Cookie:`hub=${token}`, Origin:base, 'Content-Type':'application/json'};
const request = (path, body, headers=agent) => fetch(base+path, {method:body?'POST':'GET', headers, body:body?JSON.stringify(body):undefined});
const post = async (text, extra={}) => {
  const res = await request('/api/messages', {project:'qa', author:'Leyla', kind:'approval', text, ...extra});
  assert.equal(res.status,201); return res.json();
};
const pending = async () => (await request('/api/approvals')).json();
const answer = (id, extra={}, headers=browser) => request('/api/approvals/resolve', {id, decision:'approve', as:'Demo Operator', lang:'tr', ...extra}, headers);
try {
  await test('only explicit approvals enter the cross-project oldest-first queue', async () => {
    const a = await post('Synthetic decision A', {project:'first'});
    const b = await post('Synthetic decision B', {project:'second', kind:'onay'});
    await post('please approve this ordinary request', {kind:'request'});
    const audit = new DatabaseSync(join(data,'hub.db'));
    audit.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-01-01T00:00:00Z',b.id); audit.close();
    assert.deepEqual((await pending()).map(m=>m.id),[b.id,a.id]);
    assert.equal((await request('/api/approvals',null,{})).status,401);
    assert.equal((await request('/api/messages', {project:'qa',author:'Leyla',kind:'approval',text:'wrong target',to:'Another Agent'})).status,422);
    assert.equal((await request('/api/messages', {project:'qa',author:'Leyla',kind:'approval',text:''})).status,422);
    const assets = await fetch(base+'/approvals.js'); assert.equal(assets.status,200);
    assert.match(assets.headers.get('content-type'),/javascript/);
  });
  await test('CLI accepts the localized approval alias and targets the configured operator', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['bin/hub','say','cli-demo','Synthetic CLI question','--kind','onay'], {
      cwd: new URL('..', import.meta.url), env: {...process.env,HUB_AGENT:'Aria',HUB_TOOL:'test'},
    });
    assert.match(stdout, /APPROVAL/);
    const row = (await pending()).find(m=>m.project==='cli-demo');
    assert.equal(row.kind,'approval'); assert.equal(row.to_agent,'Demo Operator');
  });
  await test('agents, missing credentials and cross-origin callers cannot answer as the operator', async () => {
    const q = await post('Browser operator only');
    assert.equal((await answer(q.id,{},agent)).status,403);
    assert.equal((await answer(q.id,{as:'Leyla'})).status,403);
    assert.equal((await answer(q.id,{}, {...browser, Origin:'https://example.invalid'})).status,403);
    assert.equal((await answer(q.id,{}, {'Content-Type':'application/json'})).status,401);
    assert.ok((await pending()).some(m=>m.id===q.id));
  });
  await test('decision posts one operator reply in the original chat and duplicate clicks do not duplicate it', async () => {
    const q = await post('One answer only', {project:'original'});
    const responses = await Promise.all([answer(q.id), answer(q.id)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
    const rows = await (await request('/api/messages?project=original')).json();
    assert.equal(rows.length,2);
    assert.equal(rows[0].text,'One answer only');
    assert.equal(rows[1].author,'Demo Operator'); assert.equal(rows[1].reply_to,q.id);
    assert.equal(rows[1].text,'Onaylandı.');
    assert.ok(!(await pending()).some(m=>m.id===q.id));
    for(let i=0;i<310;i++) await post('Newer synthetic message '+i,{project:'original',kind:'note'});
    const context = await (await request('/api/messages/context?id='+q.id)).json();
    assert.equal(context.project,'original'); assert.ok(context.messages.some(m=>m.id===q.id));
    const audit = new DatabaseSync(join(data,'hub.db'));
    assert.equal(audit.prepare('SELECT decision FROM approval_resolutions WHERE message_id=?').get(q.id).decision,'approve'); audit.close();
  });
  await test('reject and written reply retain literal text; invalid decisions and blank replies do not close questions', async () => {
    const q = await post('Custom answer', {project:'custom'});
    for (const extra of [{decision:'bad'},{decision:'reply',text:'   '},{decision:'reply',text:'x'.repeat(8001)},{id:0}]) assert.equal((await answer(q.id,extra)).status,422);
    const response = await answer(q.id,{decision:'reply',text:'Other option: <script>literal</script>'});
    assert.equal(response.status,201); assert.equal((await response.json()).text,'Other option: <script>literal</script>');
    const rejected = await post('Reject sample');
    const rejection = await answer(rejected.id,{decision:'reject',lang:'en'});
    assert.equal(rejection.status,201); assert.equal((await rejection.json()).text,'Rejected.');
  });
  await test('failed resolution rolls back its message and stays pending; withdrawn questions cannot be answered', async () => {
    const q = await post('Rollback sample', {project:'rollback'});
    const audit = new DatabaseSync(join(data,'hub.db'));
    audit.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON approval_resolutions WHEN NEW.message_id=${q.id} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;`);
    assert.equal((await answer(q.id)).status,400);
    assert.equal(audit.prepare("SELECT COUNT(*) n FROM messages WHERE project='rollback'").get().n,1);
    assert.ok((await pending()).some(m=>m.id===q.id));
    audit.exec('DROP TRIGGER synthetic_failure'); audit.close();
    assert.equal((await answer(q.id)).status,201);
    const removed = await post('Retracted question');
    assert.equal((await request('/api/messages/retract',{id:removed.id,as:'Leyla'})).status,200);
    assert.ok(!(await pending()).some(m=>m.id===removed.id));
    assert.equal((await answer(removed.id)).status,404);
  });
} finally {
  server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); rmSync(data,{recursive:true,force:true});
}
