import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairingGuard, isLocalBrowser } from '../pairing.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

test('loopback exemption requires real connection and destination; forwarded headers cannot grant it', () => {
  const req = (ip, host) => ({socket:{remoteAddress:ip},headers:{host,'x-forwarded-for':'127.0.0.1','x-test-remote-ip':'127.0.0.1'}});
  assert.equal(isLocalBrowser(req('127.0.0.1','localhost:7788'),7788),true);
  assert.equal(isLocalBrowser(req('::ffff:127.0.0.1','127.0.0.1:7788'),7788),true);
  assert.equal(isLocalBrowser(req('::1','[::1]:7788'),7788),true);
  assert.equal(isLocalBrowser(req('192.168.1.9','localhost:7788'),7788),false);
  assert.equal(isLocalBrowser(req('127.0.0.1','192.168.1.2:7788'),7788),false);
});

test('pairing expires, rotates, limits per-peer and global guesses, and resets the attempt window', () => {
  let time=0; const guard=pairingGuard(()=>time);
  const first=guard.current(); assert.match(first.code,/^[0-9]{6}$/);
  assert.equal(first.expiresAt,600000); assert.equal(guard.verify('phone',first.code),200);
  time=600000; assert.equal(guard.verify('phone',first.code),401);
  const next=guard.current(); assert.equal(next.expiresAt,1200000);
  assert.equal(guard.verify('phone',next.code),200);
  for(let i=0;i<5;i++) assert.equal(guard.verify('guess','invalid'),401);
  assert.equal(guard.verify('guess',next.code),429);
  for(let i=0;i<13;i++) assert.equal(guard.verify('peer-'+i,'invalid'),401);
  assert.equal(guard.verify('fresh-peer',next.code),429);
  time+=60000; assert.equal(guard.verify('guess',next.code),200);
  assert.equal(guard.verify('malformed',{code:next.code}),401);
  assert.equal(pairingGuard(()=>time).verify('phone',next.code),401,'a fresh server does not accept old invitations');
});

const data=mkdtempSync(join(tmpdir(),'hub-pairing-'));
process.env.HUB_DATA=data; process.env.HUB_NO_LISTEN='1'; process.env.HUB_LAN='1';
const port=25000+Math.floor(Math.random()*5000); process.env.HUB_PORT=String(port);
const {server,getLocalIps}=await import('../server.mjs');
await new Promise(r=>server.listen(port,'0.0.0.0',r));
const token=readFileSync(join(data,'token'),'utf8').trim();
const ips=getLocalIps();
// A real socket to the LAN interface exercises remoteAddress with no test header bypass.
const lan=ips[0];
const call=(path='/',{host=`${lan}:${port}`,connect='127.0.0.1',method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const req=request({hostname:connect,port,path,method,headers:{Host:host,...headers}},res=>{
    let text='';res.setEncoding('utf8');res.on('data',x=>text+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));
  });req.on('error',reject);req.end(body);
});
try {
  await test('LAN anonymous page and query cannot mint a cookie; all private endpoints stay protected', async()=>{
    assert.ok(lan,'LAN integration requires an active network interface');
    const res=await call();assert.equal(res.status,200);assert.equal(res.headers['set-cookie'],undefined);
    assert.match(res.text,/pairStatus/);assert.doesNotMatch(res.text,/id="messages"/);
    const query=await call('/?pair=123456');assert.equal(query.headers['set-cookie'],undefined);
    for(const path of ['/api/config','/api/projects','/api/agents','/api/rules','/api/approvals','/api/messages?project=demo','/api/stream','/files/000000000000000000000000']) {
      assert.equal((await call(path)).status,401,path);
    }
    assert.equal((await call('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:'demo',author:'Stranger',text:'no'})})).status,401);
    const spoof=await call('/',{connect:lan,host:`localhost:${port}`,headers:{'X-Forwarded-For':'127.0.0.1','X-Test-Remote-Ip':'127.0.0.1'}});
    assert.equal(spoof.headers['set-cookie'],undefined,'real remote peer cannot spoof loopback with Host or test/proxy headers');
    assert.equal((await call('/',{host:`evil.invalid:${port}`})).status,421);
  });
  await test('loopback settings yields a short-lived code; correct POST pairs a real LAN socket and permits ordinary use', async()=>{
    const local=await call('/',{host:`127.0.0.1:${port}`});assert.ok(local.headers['set-cookie']);
    const cfg=JSON.parse((await call('/api/config',{host:`127.0.0.1:${port}`,headers:{'X-Hub-Token':token}})).text);
    assert.equal(cfg.operator,'Operator');assert.match(cfg.pairingCode,/^[0-9]{6}$/);
    assert.ok(cfg.pairingExpiresAt>Date.now());
    const endpoint='/pair', origin=`http://${lan}:${port}`;
    const submit=(code,headers={})=>call(endpoint,{connect:lan,method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify({code})});
    assert.equal((await submit(cfg.pairingCode,{Origin:'http://evil.invalid'})).status,403);
    assert.equal((await submit(cfg.pairingCode,{Origin:''})).status,403);
    const bad=cfg.pairingCode==='111111'?'222222':'111111';
    const wrong=await submit(bad);assert.equal(wrong.status,401);assert.equal(wrong.headers['set-cookie'],undefined);
    const ok=await submit(cfg.pairingCode);assert.equal(ok.status,200);assert.ok(ok.headers['set-cookie']);
    const cookie=ok.headers['set-cookie'][0].split(';')[0];
    assert.match(ok.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);
    const remoteCfg=JSON.parse((await call('/api/config',{connect:lan,headers:{Cookie:cookie}})).text);
    assert.equal(remoteCfg.pairingCode,null,'paired device cannot invite another device');
    assert.equal(remoteCfg.pairingExpiresAt,null);
    const page=await call('/',{connect:lan,headers:{Cookie:cookie}});assert.equal(page.status,200);assert.doesNotMatch(page.text,/id="pairStatus"/);
    const post=await call('/api/messages',{connect:lan,method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({project:'demo',author:'Operator',text:'Synthetic paired browser'})});
    assert.equal(post.status,201);
    const text=JSON.parse((await call('/api/messages?project=demo',{connect:lan,headers:{Cookie:cookie}})).text);assert.equal(text[0].text,'Synthetic paired browser');
    // Two attempts above used the per-peer budget. Three more finish it.
    for(let i=0;i<3;i++) assert.equal((await submit(bad)).status,401);
    const locked=await submit(cfg.pairingCode);assert.equal(locked.status,429);assert.equal(locked.headers['set-cookie'],undefined);
    const oversized=await call('/pair',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:'x'.repeat(300)})});assert.equal(oversized.status,413);
    const anon=await call('/api/messages?project=demo');assert.equal(anon.status,401,'data stays private even after another client has paired');
  });
} finally {
  server.closeAllConnections(); await new Promise(r=>server.close(r));rmSync(data,{recursive:true,force:true});
}
