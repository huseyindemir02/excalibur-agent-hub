import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
const chromePath=[process.env.CHROME_BIN,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);

test('new UI refuses unidentified writes and explains LAN pairing before and after restart', {skip:!chromePath&&'Set CHROME_BIN for browser coverage'},async()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const approvals=readFileSync(new URL('../public/approvals.js',import.meta.url),'utf8');
  const profile=mkdtempSync(join(tmpdir(),'hub-version-ui-'));
  let mode='old',lan=false,configuredLan=false,code=null;const writes=[];
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html.replace('<head>', '<head><script>localStorage.setItem("hub.project","demo");localStorage.setItem("hub.lang","en");window.alert=()=>{};</script>'));return}
    if(url.pathname==='/approvals.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(approvals);return}
    if(url.pathname==='/api/stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': connected\n\n');return}
    let body='';for await(const x of req)body+=x;
    res.setHeader('Content-Type','application/json');
    if(req.method!=='GET'){writes.push({path:url.pathname,body:body?JSON.parse(body):null});if(url.pathname==='/api/config'){configuredLan=JSON.parse(body).lan;res.end(JSON.stringify({ok:true,restartRequired:true,command:'restart-demo'}));return}res.end(JSON.stringify({id:1}));return}
    if(url.pathname==='/api/config'){
      res.statusCode=mode==='old'?404:mode==='offline'?503:200;
      res.end(JSON.stringify(mode==='good'?{operator:'Synthetic Operator',port:7788,configuredPort:7788,lan,configuredLan,localIps:['192.168.1.20'],pairingCode:code}:mode==='invalid'?{}:{error:'unavailable'}));return;
    }
    res.end(JSON.stringify(url.pathname==='/api/projects'?[{slug:'demo',title:'Synthetic demo'}]:[]));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});let ws;
  try{
    let port;for(let i=0;i<100;i++){try{port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);break}catch{}await new Promise(r=>setTimeout(r,50))}assert.ok(port);
    const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
    let seq=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(pending.delete(id))reject(Error('CDP timeout'))},5000).unref()});
    const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value};
    const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,30))}assert.fail('browser condition: '+expression)};
    await send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('hub.project','demo');localStorage.setItem('hub.lang','en');window.alert=()=>{};`});
    await send('Emulation.setDeviceMetricsOverride',{width:320,height:700,deviceScaleFactor:1,mobile:true});
    await send('Page.navigate',{url:base});await until(`!document.getElementById('operatorWarning').hidden`);
    assert.match(await evaluate(`document.getElementById('operatorWarningText').textContent`),/out of date/);
    assert.equal(await evaluate(`document.querySelector('#composer .send').disabled`),true);
    assert.notEqual(await evaluate(`getComputedStyle(document.getElementById('operatorWarning')).display`),'none');
    // Direct invocation bypasses disabled buttons: both attachment and message writes must still be refused.
    await evaluate(`document.getElementById('text').value='Synthetic blocked message';const files=new DataTransfer();files.items.add(new File(['demo'],'demo.txt',{type:'text/plain'}));document.getElementById('fileInput').files=files.files;document.getElementById('fileInput').dispatchEvent(new Event('change'));document.getElementById('composer').dispatchEvent(new Event('submit',{cancelable:true}))`);
    await new Promise(r=>setTimeout(r,50));assert.equal(writes.length,0);
    assert.equal(await evaluate(`document.getElementById('text').value`),'Synthetic blocked message');
    for(const [lang,dir] of [['tr','ltr'],['ja','ltr'],['ar','rtl'],['zh','ltr'],['en','ltr']]){
      await evaluate(`document.getElementById('langSelect').value=${JSON.stringify(lang)};document.getElementById('langSelect').dispatchEvent(new Event('change'))`);
      assert.equal(await evaluate('document.documentElement.dir'),dir);assert.ok(await evaluate(`document.getElementById('operatorWarningText').textContent.length>10`));
    }
    for(const failure of ['invalid','offline']){
      mode=failure;await evaluate(`document.getElementById('operatorRetry').click()`);await until(`!document.getElementById('operatorRetry').disabled`);
      assert.match(await evaluate(`document.getElementById('operatorWarningText').textContent`),/could not be verified/);
      assert.equal(await evaluate(`document.querySelector('#composer .send').disabled`),true);assert.equal(writes.length,0);
    }
    mode='good';await evaluate(`document.getElementById('operatorRetry').click()`);await until(`document.getElementById('operatorWarning').hidden && !document.querySelector('#composer .send').disabled`);
    // Remove the pending attachment so the positive control is one ordinary message.
    await evaluate(`document.querySelector('#pending button').click();document.getElementById('composer').requestSubmit()`);
    await until(`document.getElementById('text').value===''`);assert.equal(writes.length,1);assert.equal(writes[0].body.author,'Synthetic Operator');assert.equal(writes[0].path,'/api/messages');
    await evaluate(`document.getElementById('openSettings').click()`);await until(`document.getElementById('settingsModal').open && document.getElementById('lanPairingHint').textContent.includes('enable local network')`);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('lanUrlsContainer')).display`),'none');
    await evaluate(`document.getElementById('cfgLanToggle').click()`);await until(`document.getElementById('lanPairingHint').textContent.includes('restart the server')`);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('lanUrlsContainer')).display`),'none','toggling alone cannot advertise a code');
    await evaluate(`document.getElementById('settingsForm').requestSubmit()`);await until(`!document.getElementById('settingsRestartBanner').hidden`);
    assert.equal(configuredLan,true);assert.equal(lan,false);assert.equal(await evaluate(`getComputedStyle(document.getElementById('lanUrlsContainer')).display`),'none');
    lan=true;code='123456';await evaluate(`document.getElementById('closeSettings').click();document.getElementById('openSettings').click()`);await until(`!document.getElementById('lanUrlsContainer').hidden`);
    assert.equal(await evaluate(`document.getElementById('lanPairingCode').textContent`),code);assert.equal(await evaluate(`document.getElementById('lanPairingHint').hidden`),true);assert.notEqual(await evaluate(`getComputedStyle(document.getElementById('lanUrlsContainer')).display`),'none');
    code=null;await evaluate(`document.getElementById('closeSettings').click();document.getElementById('openSettings').click()`);await until(`document.getElementById('lanPairingHint').textContent.includes('localhost')`);assert.equal(await evaluate(`getComputedStyle(document.getElementById('lanUrlsContainer')).display`),'none');
    // A failed recheck also revokes a previously verified identity, without sending under the old one.
    mode='old';await evaluate(`document.getElementById('closeSettings').click();document.getElementById('openSettings').click()`);await until(`!document.getElementById('operatorWarning').hidden`);assert.equal(await evaluate(`document.querySelector('#composer .send').disabled`),true);
    assert.equal(writes.filter(x=>x.path==='/api/messages').length,1);
  }finally{ws?.close();chrome.kill('SIGKILL');await new Promise(r=>chrome.once('close',r));server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true})}
});
