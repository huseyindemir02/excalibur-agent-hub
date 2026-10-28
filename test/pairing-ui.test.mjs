import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const chromePath=[process.env.CHROME_BIN,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean).find(existsSync);
test('real mobile LAN browser pairs manually and by QR fragment without sending the code in a URL', {skip:!chromePath && 'Set CHROME_BIN for browser coverage'},async()=>{
  const data=mkdtempSync(join(tmpdir(),'hub-pair-ui-'));
  process.env.HUB_DATA=data;process.env.HUB_NO_LISTEN='1';process.env.HUB_LAN='1';
  const port=30000+Math.floor(Math.random()*2000);process.env.HUB_PORT=String(port);
  const {server,getLocalIps}=await import('../server.mjs');
  await new Promise(r=>server.listen(port,'0.0.0.0',r));
  const token=readFileSync(join(data,'token'),'utf8').trim();
  const cfg=await(await fetch(`http://127.0.0.1:${port}/api/config`,{headers:{'X-Hub-Token':token}})).json();
  const lan=getLocalIps()[0];assert.ok(lan);const base=`http://${lan}:${port}`;
  const chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${join(data,'browser')}`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
  let ws;
  try {
    let debugPort;
    for(let i=0;i<100;i++){try{debugPort=Number(readFileSync(join(data,'browser/DevToolsActivePort'),'utf8').split('\n')[0]);break}catch{}await new Promise(r=>setTimeout(r,50))}
    assert.ok(debugPort);
    const pages=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
    let seq=0;const pending=new Map(),urls=[];
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Network.requestWillBeSent')urls.push(m.params.request.url);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.delete(id))reject(Error('CDP timeout'))},5000).unref()});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value};
    const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50))}assert.fail('browser condition: '+expression)};
    await send('Network.enable');await send('Emulation.setDeviceMetricsOverride',{width:320,height:700,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url:base});await until('!!document.getElementById("pairStatus")');
    const layout=await evaluate('({scroll:document.documentElement.scrollWidth,height:document.querySelector("button").getBoundingClientRect().height})');assert.equal(layout.scroll,320);assert.ok(layout.height>=44);
    for(const [lang,dir] of [['tr','ltr'],['ja','ltr'],['ar','rtl'],['zh','ltr'],['en','ltr']]) {
      await evaluate(`document.getElementById('pairLanguage').value=${JSON.stringify(lang)};document.getElementById('pairLanguage').dispatchEvent(new Event('change'))`);
      assert.equal(await evaluate('document.documentElement.dir'),dir);
      assert.equal(await evaluate('document.documentElement.scrollWidth'),320);
    }
    await evaluate(`document.querySelector('input').value='invalid';document.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true}))`);
    await until('document.getElementById("pairStatus").textContent.length>0');assert.match(await evaluate('document.getElementById("pairStatus").textContent'),/Invalid/);
    await evaluate(`document.querySelector('input').value=${JSON.stringify(cfg.pairingCode)};document.querySelector('form').requestSubmit()`);
    await until('!!document.getElementById("openSettings")');
    assert.equal(await evaluate('location.hash'),'');
    const cookies=await send('Network.getCookies',{urls:[base]});assert.ok(cookies.cookies.some(c=>c.name==='hub'&&c.httpOnly));
    await send('Network.clearBrowserCookies');
    await send('Page.navigate',{url:'about:blank'});
    await until(`location.href==='about:blank'`);
    await send('Page.navigate',{url:base+'/#pair='+cfg.pairingCode});
    await until('!!document.getElementById("openSettings") && location.hash === ""');
    assert.ok(urls.some(u=>new URL(u).pathname==='/pair'));
    assert.ok(urls.filter(u=>u.startsWith(base)).every(u=>!new URL(u).searchParams.has('pair')),'pairing code never sent as a query');
    assert.equal(await evaluate('document.cookie.includes("hub=")'),false,'cookie stays HttpOnly');
    await send('Page.navigate',{url:`http://127.0.0.1:${port}`});
    await until(`typeof document.getElementById('openSettings')?.onclick==='function'`);
    await evaluate(`document.getElementById('openSettings').click()`);
    await until(`document.getElementById('settingsModal').open && /^[0-9]{6}$/.test(document.getElementById('lanPairingCode').textContent)`);
    const links=await evaluate(`[...document.querySelectorAll('.lan-url-link')].map(a=>a.href)`);
    assert.ok(links.length);assert.ok(links.every(u=>new URL(u).hash==='#pair='+cfg.pairingCode && !new URL(u).search));
    assert.ok(await evaluate(`!!document.querySelector('#lanQrCode svg')`));
  } finally {
    ws?.close();chrome.kill('SIGKILL');await new Promise(r=>chrome.once('close',r));server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(data,{recursive:true,force:true});
  }
});
