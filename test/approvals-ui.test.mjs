import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const chromePath = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')].filter(Boolean).find(existsSync);
test('approval inbox: real mobile viewport, keyboard, literal question, translations and single reply', {skip: !chromePath && 'Set CHROME_BIN to run browser coverage'}, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'hub-approval-ui-'));
  const source = readFileSync(new URL('../public/approvals.js', import.meta.url),'utf8');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><html lang="tr"><style>:root{--line:#ddd;--panel:#fff;--ink:#152730;--chip:#f1f4f5;--muted:#52616b;--accent:#c3263a;--bg:#f5f7f8}body{font:15px system-ui;margin:12px}.host{display:flex;gap:8px}</style><div class="host"></div><script src="/approvals.js"></script><script>
    window.lang='tr'; window.calls=[]; window.opened=null; window.failLoad=false;
    window.questions=[{id:1,project:'alpha',author:'Synthetic Agent',text:'<img src=x onerror="window.bad=true"> What should we do?',created_at:new Date(Date.now()-90000000).toISOString()},{id:2,project:'beta',author:'Another Agent',text:'Choose the next step',created_at:new Date().toISOString()}];
    window.inbox=mountApprovalInbox({host:document.querySelector('.host'),language:()=>lang,operator:()=> 'Hüseyin',projectTitle:p=>p,openQuestion:async row=>{opened=row.id},api:async(path,opt)=>{
      if(!opt){if(failLoad)throw Error('offline');return structuredClone(questions)}
      calls.push(JSON.parse(opt.body));await new Promise(r=>setTimeout(r,50));questions=questions.filter(x=>x.id!==calls.at(-1).id);return {id:10};
    }});
  </script></html>`;
  const server = createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/approvals.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/approvals.js'?source:html)});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check',base],{stdio:'ignore'});
  let ws;
  try {
    let port;
    for(let i=0;i<100;i++){try{port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);break}catch{}await new Promise(r=>setTimeout(r,50))}
    assert.ok(port,'Chrome started');
    const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
    await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
    let seq=0;const pending=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.delete(id))reject(Error('CDP timeout'))},5000).unref()});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value};
    for(let i=0;i<100;i++){if(await evaluate('!!window.inbox'))break;await new Promise(r=>setTimeout(r,50))}
    await send('Emulation.setDeviceMetricsOverride',{width:320,height:700,deviceScaleFactor:1,mobile:true});
    await evaluate(`document.querySelector('.approval-toggle').click()`);
    const layout=await evaluate(`(()=>{const d=document.querySelector('dialog');return {open:d.open,width:d.getBoundingClientRect().width,scroll:document.documentElement.scrollWidth,labels:[...d.querySelectorAll('.approval-meta strong')].map(n=>n.textContent),overdue:d.querySelectorAll('.approval-overdue').length,images:d.querySelectorAll('img').length,minHeight:Math.min(...[...d.querySelectorAll('button')].map(b=>b.getBoundingClientRect().height))}})()`);
    assert.equal(layout.open,true);assert.ok(layout.width<=320);assert.equal(layout.scroll,320);assert.deepEqual(layout.labels,['alpha','beta']);assert.equal(layout.overdue,1);assert.equal(layout.images,0);assert.ok(layout.minHeight>=44);
    for(const [lang,label,dir] of [['en','My pending approvals','ltr'],['ja','自分の承認待ち','ltr'],['ar','الموافقات المعلقة','rtl'],['zh','我的待审批事项','ltr']]) {
      const result=await evaluate(`lang=${JSON.stringify(lang)};document.documentElement.dir=${JSON.stringify(dir)};inbox.translate();({title:document.querySelector('h2').textContent,width:document.querySelector('dialog').getBoundingClientRect().width})`);
      assert.equal(result.title,label);assert.ok(result.width<=320);
    }
    await evaluate(`lang='tr';document.documentElement.dir='ltr';inbox.translate();document.querySelector('.approval-actions button:last-child').click();const x=document.querySelector('textarea');x.value='A different choice';x.dispatchEvent(new Event('input'));document.querySelector('.approval-reply').requestSubmit();document.querySelector('.approval-reply').requestSubmit()`);
    await new Promise(r=>setTimeout(r,120));
    assert.deepEqual(await evaluate('calls'),[{id:1,decision:'reply',text:'A different choice',as:'Hüseyin',lang:'tr'}]);
    assert.equal(await evaluate(`document.querySelectorAll('.approval-item').length`),1);
    assert.equal(await evaluate(`document.activeElement.closest('.approval-item')?.dataset.approvalId`),'2');
    await evaluate(`document.querySelector('.approval-item > button').click()`);
    assert.equal(await evaluate('opened'),2);assert.equal(await evaluate(`document.querySelector('dialog').open`),false);
    await evaluate(`document.querySelector('.approval-toggle').click()`);
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    for(let i=0;i<100;i++){if(await evaluate(`document.activeElement.id==='approvalInboxToggle'`))break;await new Promise(r=>setTimeout(r,20))}
    assert.equal(await evaluate(`document.querySelector('dialog').open`),false);
    assert.equal(await evaluate(`document.activeElement.id`),'approvalInboxToggle');
    await evaluate(`(async()=>{failLoad=true;document.querySelector('.approval-toggle').click();await inbox.refresh()})()`);
    assert.match(await evaluate(`document.querySelector('[role=alert]').textContent`),/Yüklenemedi/);
    await evaluate(`(async()=>{failLoad=false;questions=[];await inbox.refresh()})()`);
    assert.equal(await evaluate(`document.querySelector('.approval-empty').textContent`),'Bekleyen onay yok.');
  } finally {
    ws?.close();chrome.kill('SIGKILL');await new Promise(r=>chrome.once('close',r));
    server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true});
  }
});
