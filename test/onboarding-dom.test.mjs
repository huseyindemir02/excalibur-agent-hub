import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, spawn } from 'node:child_process';

const HTML_CONTENT = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function findChrome() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch {}
  }
  return null;
}

test('Headless Chrome DOM, CSS & Network Regressions', async (t) => {
  const chromePath = findChrome();
  if (!chromePath) {
    t.skip('Chrome binary not found on this system');
    return;
  }

  // 1. Setup local HTTP server serving index.html and mocking API
  const serverPort = 37100 + Math.floor(Math.random() * 5000);
  const localServer = createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML_CONTENT);
    } else if (req.url === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    } else if (req.url === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ operator: 'Operator', configuredOperator: 'Hüseyin', port: 7788, lan: false, localIps: [], version: '2.0.0 (test)', dataDir: '/tmp/.agent-hub' }));
    } else if (req.url.startsWith('/api/messages?project=qa')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 77, project: 'qa', author: 'Luna', kind: 'chat', text: 'Swipe test message', created_at: '2026-10-27T06:00:00Z', reactions: [] }]));
    } else if (req.method === 'POST' && req.url === '/api/messages/react') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 77, reactions: [{ emoji: '👍', count: 1, authors: ['Operator'] }] }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
  });

  await new Promise(r => localServer.listen(serverPort, '127.0.0.1', r));

  // 2. Launch headless Chrome with clean profile
  const userDataDir = mkdtempSync(join(tmpdir(), 'chrome-profile-'));
  const cdpPort = serverPort + 100;
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `http://127.0.0.1:${serverPort}/`
  ]);

  try {
    let targetWsUrl = null;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
        const pages = await res.json();
        const mainPage = pages.find(p => p.type === 'page' && p.url.includes(String(serverPort))) || pages.find(p => p.type === 'page');
        if (mainPage?.webSocketDebuggerUrl) {
          targetWsUrl = mainPage.webSocketDebuggerUrl;
          break;
        }
      } catch {}
    }
    assert.ok(targetWsUrl, 'Failed to connect to headless Chrome CDP');

    const ws = new WebSocket(targetWsUrl);
    let msgId = 1;
    const pending = new Map();

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && pending.has(data.id)) {
        pending.get(data.id)(data);
        pending.delete(data.id);
      }
    };

    await new Promise(r => { ws.onopen = r; });

    const send = (method, params = {}) => new Promise((resolve) => {
      const id = msgId++;
      pending.set(id, (res) => resolve(res.result));
      ws.send(JSON.stringify({ id, method, params }));
    });

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || 'Evaluation error');
      }
      return result?.result?.value;
    };

    // Wait until document and onboardingModal are ready
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 100));
      try {
        const chk = await send('Runtime.evaluate', {
          expression: 'document.readyState === "complete" && !!document.getElementById("onboardingModal")',
          returnByValue: true
        });
        if (chk?.result?.value === true) break;
      } catch (e) {}
    }

    // --- SUBTEST A: Dialog computed display is none when closed, flex when open, and hides on real Escape ---
    const initialDisplay = await evaluate(`
      (() => {
        const d = document.getElementById('onboardingModal');
        return {
          open: d.open,
          hasOpenAttr: d.hasAttribute('open'),
          computedDisplay: window.getComputedStyle(d).display,
          offsetWidth: d.offsetWidth,
          offsetHeight: d.offsetHeight
        };
      })()
    `);

    assert.equal(initialDisplay.open, false, 'Dialog should initially not be open');
    assert.equal(initialDisplay.hasOpenAttr, false, 'Dialog should not have open attribute');
    assert.equal(initialDisplay.computedDisplay, 'none', 'Computed display must be none when closed');
    assert.equal(initialDisplay.offsetWidth, 0, 'Offset width must be 0 when closed');
    assert.equal(initialDisplay.offsetHeight, 0, 'Offset height must be 0 when closed');

    // Open dialog with showModal()
    const openDisplay = await evaluate(`
      (() => {
        const d = document.getElementById('onboardingModal');
        d.showModal();
        return {
          open: d.open,
          hasOpenAttr: d.hasAttribute('open'),
          computedDisplay: window.getComputedStyle(d).display,
          width: d.offsetWidth,
          height: d.offsetHeight
        };
      })()
    `);

    assert.equal(openDisplay.open, true, 'Dialog should be open after showModal');
    assert.equal(openDisplay.hasOpenAttr, true, 'Dialog should have open attribute after showModal');
    assert.equal(openDisplay.computedDisplay, 'flex', 'Computed display must be flex when open');
    assert.ok(openDisplay.width > 200, 'Dialog should have visible width when open');

    // Close dialog with close()
    const closeDisplay = await evaluate(`
      (() => {
        const d = document.getElementById('onboardingModal');
        d.close();
        return {
          open: d.open,
          hasOpenAttr: d.hasAttribute('open'),
          computedDisplay: window.getComputedStyle(d).display,
          offsetWidth: d.offsetWidth
        };
      })()
    `);

    assert.equal(closeDisplay.open, false, 'Dialog should be closed after close()');
    assert.equal(closeDisplay.computedDisplay, 'none', 'Computed display must return to none after close()');
    assert.equal(closeDisplay.offsetWidth, 0);

    // Reopen and send REAL CDP Escape key event
    await evaluate(`document.getElementById('onboardingModal').showModal()`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise(r => setTimeout(r, 100));

    const escapeDisplay = await evaluate(`
      (() => {
        const d = document.getElementById('onboardingModal');
        return {
          open: d.open,
          computedDisplay: window.getComputedStyle(d).display
        };
      })()
    `);

    assert.equal(escapeDisplay.open, false, 'Dialog should close on real Escape key');
    assert.equal(escapeDisplay.computedDisplay, 'none', 'Computed display must be none after Escape key');

    // --- SUBTEST B: Live DOM localization (English & Arabic RTL) ---
    const enDom = await evaluate(`
      (() => {
        const select = document.getElementById('langSelect');
        select.value = 'en';
        select.dispatchEvent(new Event('change'));
        return {
          lang: document.documentElement.getAttribute('lang'),
          dir: document.documentElement.getAttribute('dir'),
          sendAria: document.querySelector('#composer .send').getAttribute('aria-label'),
          kindFirstOpt: document.querySelector('#kind').options[0].textContent,
          placeholder: document.querySelector('#text').placeholder,
          themeAria: document.getElementById('toggleTheme').getAttribute('aria-label'),
          toggleLeftAria: document.getElementById('toggleLeft').getAttribute('aria-label'),
          welcomeTitle: document.querySelector('.empty-welcome-card h3')?.textContent
        };
      })()
    `);

    assert.equal(enDom.lang, 'en');
    assert.equal(enDom.dir, 'ltr');
    assert.equal(enDom.sendAria, 'Send');
    assert.equal(enDom.kindFirstOpt, 'Chat');
    assert.ok(enDom.placeholder.includes('Type a message'));
    assert.equal(enDom.themeAria, 'Theme');
    assert.equal(enDom.toggleLeftAria, 'Toggle left panel');
    assert.ok(enDom.welcomeTitle.includes('Welcome to Agent Hub'));

    const arDom = await evaluate(`
      (() => {
        const select = document.getElementById('langSelect');
        select.value = 'ar';
        select.dispatchEvent(new Event('change'));
        return {
          lang: document.documentElement.getAttribute('lang'),
          dir: document.documentElement.getAttribute('dir'),
          sendAria: document.querySelector('#composer .send').getAttribute('aria-label'),
          kindFirstOpt: document.querySelector('#kind').options[0].textContent,
          placeholder: document.querySelector('#text').placeholder,
          themeAria: document.getElementById('toggleTheme').getAttribute('aria-label'),
          welcomeTitle: document.querySelector('.empty-welcome-card h3')?.textContent
        };
      })()
    `);

    assert.equal(arDom.lang, 'ar');
    assert.equal(arDom.dir, 'rtl');
    assert.equal(arDom.sendAria, 'إرسال');
    assert.equal(arDom.kindFirstOpt, 'دردشة');
    assert.ok(arDom.placeholder.includes('اكتب رسالة'));
    assert.equal(arDom.themeAria, 'المظهر');
    assert.ok(arDom.welcomeTitle.includes('مرحباً بك في Agent Hub'));

    // --- SUBTEST C: Real Viewport Emulation (320x700), Touch Targets & Mobile Drawer Close ---
    await send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 700,
      deviceScaleFactor: 1,
      mobile: true
    });
    await new Promise(r => setTimeout(r, 100));

    // Measure Send button touch target size in 320px viewport
    const sendBtnMetrics = await evaluate(`
      (() => {
        const btn = document.querySelector('#composer .send');
        const rect = btn.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })()
    `);
    assert.ok(sendBtnMetrics.width >= 44, `Send button width must be >= 44px on mobile, got ${sendBtnMetrics.width}`);
    assert.ok(sendBtnMetrics.height >= 44, `Send button height must be >= 44px on mobile, got ${sendBtnMetrics.height}`);

    // Test Left Drawer opening and closing via close button and Escape
    const drawerTest = await evaluate(`
      (() => {
        const app = document.querySelector('.app');
        const toggleLeft = document.getElementById('toggleLeft');
        toggleLeft.click();
        const opened = app.classList.contains('left-open');
        const closeBtn = document.getElementById('closeLeft');
        const closeBtnVisible = closeBtn && window.getComputedStyle(closeBtn).display !== 'none';
        const closeRect = closeBtn.getBoundingClientRect();
        
        // Click close button
        closeBtn.click();
        const closedAfterBtn = !app.classList.contains('left-open');

        // Re-open
        toggleLeft.click();
        const reOpened = app.classList.contains('left-open');

        return {
          opened,
          closeBtnVisible,
          closeWidth: closeRect.width,
          closeHeight: closeRect.height,
          closedAfterBtn,
          reOpened
        };
      })()
    `);

    assert.equal(drawerTest.opened, true, 'Clicking toggleLeft must open left drawer on mobile');
    assert.equal(drawerTest.closeBtnVisible, true, 'Close button must be visible in open drawer');
    assert.ok(drawerTest.closeWidth >= 44 && drawerTest.closeHeight >= 44, 'Close button touch target must be >= 44px');
    assert.equal(drawerTest.closedAfterBtn, true, 'Clicking close button must close the left drawer');
    assert.equal(drawerTest.reOpened, true, 'Should re-open left drawer');

    // Test closing left drawer via Escape key
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await new Promise(r => setTimeout(r, 100));

    const closedByEscape = await evaluate(`!document.querySelector('.app').classList.contains('left-open')`);
    assert.equal(closedByEscape, true, 'Left drawer must close on Escape key');

    // Test Right Drawer opening and closing via close button
    const rightDrawerTest = await evaluate(`
      (() => {
        const app = document.querySelector('.app');
        document.getElementById('toggleRight').click();
        const opened = app.classList.contains('right-open');
        const closeBtn = document.getElementById('closeRight');
        const closeBtnVisible = closeBtn && window.getComputedStyle(closeBtn).display !== 'none';
        closeBtn.click();
        const closed = !app.classList.contains('right-open');
        return { opened, closeBtnVisible, closed };
      })()
    `);
    assert.equal(rightDrawerTest.opened, true, 'Clicking toggleRight must open right drawer');
    assert.equal(rightDrawerTest.closeBtnVisible, true, 'Close button must be visible in right drawer');
    assert.equal(rightDrawerTest.closed, true, 'Clicking close button must close right drawer');

    // Test 375x812 WhatsApp-style mobile layout, zero horizontal overflow, >=60% messages height, overflow menu, and pending attachment truncation
    await send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true
    });
    await new Promise(r => setTimeout(r, 80));

    const mobileWhatsappMetrics = await evaluate(`
      (() => {
        const app = document.querySelector('.app');
        const head = document.querySelector('.chat-head');
        const msgs = document.getElementById('messages');
        const projSelect = document.getElementById('projSelect');
        const backBtn = document.getElementById('mobileBackBtn');
        const moreBtn = document.getElementById('mobileMoreBtn');
        const toggles = document.getElementById('panelToggles');

        const togglesHiddenInitially = window.getComputedStyle(toggles).display === 'none';
        const projSelectHidden = window.getComputedStyle(projSelect).display === 'none';

        moreBtn.click();
        const menuOpened = app.classList.contains('mobile-menu-open') && window.getComputedStyle(toggles).display === 'flex';
        moreBtn.click();
        const menuClosed = !app.classList.contains('mobile-menu-open');

        backBtn.click();
        const chatListOpened = app.classList.contains('left-open');
        const leftWidth = document.querySelector('aside.side.left').getBoundingClientRect().width;
        document.getElementById('closeLeft').click();

        // Simulate attaching 3 long-named screenshots
        const dt = new DataTransfer();
        for (let i = 1; i <= 3; i++) {
          dt.items.add(new File(['img'], 'Screenshot_2026-10-27-11-23-52-40_04037198b9c383a6ec289f72a6a022f' + i + '.jpg', { type: 'image/jpeg' }));
        }
        const fileInput = document.getElementById('fileInput');
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change'));

        const pendingRect = document.getElementById('pending').getBoundingClientRect();
        const firstChipName = document.querySelector('#pending .file-name')?.textContent || '';

        // Dismiss PWA banner
        const pwaBanner = document.getElementById('pwaBanner');
        const pwaVisibleInitially = !pwaBanner.hidden;
        document.getElementById('pwaDismissBtn').click();
        const pwaHiddenAfterDismiss = pwaBanner.hidden;

        // Probe: when requestFullscreen rejects, user sees a visible warning message instead of silent failure (#6242)
        const origReqFs = document.documentElement.requestFullscreen;
        document.documentElement.requestFullscreen = () => Promise.reject(new Error('denied'));
        document.getElementById('pwaFullscreenBtn').click();
        return new Promise(r => setTimeout(r, 30)).then(() => {
          document.documentElement.requestFullscreen = origReqFs;
          const fsErrorShown = !pwaBanner.hidden && document.getElementById('pwaBannerText').textContent.includes('⚠️');
          document.getElementById('pwaDismissBtn').click();

          const scrollWidth = document.documentElement.scrollWidth;
          const headRect = head.getBoundingClientRect();
          const msgsRect = msgs.getBoundingClientRect();

          return {
            scrollWidth,
            headHeight: headRect.height,
            msgsHeight: msgsRect.height,
            msgsRatio: msgsRect.height / 812,
            togglesHiddenInitially,
            projSelectHidden,
            menuOpened,
            menuClosed,
            chatListOpened,
            leftWidth,
            pendingHeight: pendingRect.height,
            firstChipName,
            pwaVisibleInitially,
            pwaHiddenAfterDismiss,
            fsErrorShown
          };
        });
      })()
    `);

    assert.ok(mobileWhatsappMetrics.scrollWidth <= 375, `Mobile scrollWidth must be <= 375px, got ${mobileWhatsappMetrics.scrollWidth}`);
    assert.ok(mobileWhatsappMetrics.headHeight <= 64, `Mobile header height must be compact (<= 64px), got ${mobileWhatsappMetrics.headHeight}`);
    assert.ok(mobileWhatsappMetrics.msgsRatio >= 0.60, `Messages area must be >= 60% of 812px viewport, got ${(mobileWhatsappMetrics.msgsRatio * 100).toFixed(1)}% (${mobileWhatsappMetrics.msgsHeight}px)`);
    assert.equal(mobileWhatsappMetrics.togglesHiddenInitially, true, 'Toolbar buttons must be collapsed into overflow menu on mobile');
    assert.equal(mobileWhatsappMetrics.projSelectHidden, true, 'Duplicate project select must be hidden on mobile');
    assert.equal(mobileWhatsappMetrics.menuOpened, true, 'Clicking ⋮ button must open mobile overflow menu');
    assert.equal(mobileWhatsappMetrics.menuClosed, true, 'Clicking ⋮ button again must close mobile overflow menu');
    assert.equal(mobileWhatsappMetrics.chatListOpened, true, 'Clicking ← back button must open full-screen chat list');
    assert.equal(mobileWhatsappMetrics.leftWidth, 375, 'Mobile chat list must fill 375px screen width');
    assert.ok(mobileWhatsappMetrics.pendingHeight <= 52, `Pending 3 attachments strip must stay compact (<= 52px), got ${mobileWhatsappMetrics.pendingHeight}`);
    assert.ok(mobileWhatsappMetrics.firstChipName.includes('…'), `Long attachment filename must be middle-truncated, got ${mobileWhatsappMetrics.firstChipName}`);
    assert.equal(mobileWhatsappMetrics.pwaVisibleInitially, true, 'PWA install banner must be shown initially on mobile');
    assert.equal(mobileWhatsappMetrics.pwaHiddenAfterDismiss, true, 'PWA install banner must hide when dismissed');
    assert.equal(mobileWhatsappMetrics.fsErrorShown, true, 'Rejected requestFullscreen must show visible warning instead of failing silently');

    // Test mobile horizontal Swipe-to-Reply and Emoji Reaction picker on a rendered message (#6250 / #6255)
    const swipeAndReactMetrics = await evaluate(`
      (async () => {
        const sel = document.getElementById('projSelect');
        sel.append(new Option('QA', 'qa'));
        sel.value = 'qa';
        sel.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 60));

        const bubble = document.querySelector('.row-msg[data-id="77"] .bubble');
        if (!bubble) return { found: false };

        // Simulate horizontal touch swipe (+65px right, +2px vertical)
        const mkTouch = (x, y) => {
          const ev = new Event(x === 40 ? 'touchstart' : 'touchmove', { bubbles: true });
          ev.touches = [{ clientX: x, clientY: y }];
          return ev;
        };
        bubble.dispatchEvent(mkTouch(40, 200));
        bubble.dispatchEvent(mkTouch(105, 202));
        bubble.dispatchEvent(new Event('touchend', { bubbles: true }));

        const replyOpened = document.getElementById('replying').classList.contains('on');
        const replyAuthor = document.querySelector('#replyQuote b')?.textContent || '';
        document.getElementById('cancelReply').click();

        // Open reaction picker and click 👍
        bubble.querySelector('.react-btn').click();
        const pickerOpened = !!bubble.querySelector('.react-picker');
        bubble.querySelector('.react-picker button[aria-label="👍"]').click();
        await new Promise(r => setTimeout(r, 60));
        const chipText = bubble.querySelector('.react-chip')?.textContent || '';

        return { found: true, replyOpened, replyAuthor, pickerOpened, chipText };
      })()
    `);
    assert.equal(swipeAndReactMetrics.found, true, 'Message #77 bubble must render');
    assert.equal(swipeAndReactMetrics.replyOpened, true, 'Horizontal swipe on message bubble must trigger reply mode');
    assert.equal(swipeAndReactMetrics.replyAuthor, 'Luna', 'Swipe-to-reply must quote the swiped message author');
    assert.equal(swipeAndReactMetrics.pickerOpened, true, 'Reaction picker must open on message');
    assert.equal(swipeAndReactMetrics.chipText, '👍 1', 'Selecting an emoji reaction must render compact reaction chip on bubble');

    // Test Excalibur Agent Hub brand rename, ⋮ Menü button, #openSettingsLeft on home screen, mobile Enter newline (#6293), and enriched #settingsModal (#6264, #6268, #6270, #6273, #6281)
    const settingsMetrics = await evaluate(`
      (async () => {
        document.querySelector('.app').classList.add('left-open');
        const gearRect = document.getElementById('openSettingsLeft').getBoundingClientRect();
        document.getElementById('openSettingsLeft').click();
        await new Promise(r => setTimeout(r, 60));
        const openedFromHome = document.getElementById('settingsModal')?.open === true;
        const opVal = document.getElementById('cfgOperatorInput')?.value || '';
        const langExists = !!document.getElementById('settingsLangSelect');
        const rulesExists = !!document.getElementById('settingsRulesBtn');
        const verText = document.getElementById('cfgVersionText')?.textContent || '';
        const dirText = document.getElementById('cfgDataDirText')?.textContent || '';
        const moreText = document.getElementById('mobileMoreBtn')?.textContent?.trim() || '';
        document.getElementById('closeSettings').click();
        document.querySelector('.app').classList.remove('left-open');

        // Verify Enter key does NOT preventDefault / auto-submit on mobile viewport (#6293)
        const enterEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        const notPreventedOnMobile = document.getElementById('text').dispatchEvent(enterEv);

        return {
          title: document.title,
          gearW: gearRect.width,
          gearH: gearRect.height,
          openedFromHome,
          opVal,
          langExists,
          rulesExists,
          verText,
          dirText,
          moreText,
          lang: document.documentElement.lang,
          notPreventedOnMobile
        };
      })()
    `);
    assert.equal(settingsMetrics.title, 'Excalibur Agent Hub', 'Document title must be Excalibur Agent Hub');
    assert.ok(settingsMetrics.gearW >= 44 && settingsMetrics.gearH >= 44, `Home screen ⚙️ button touch target must be >= 44x44px, got ${settingsMetrics.gearW}x${settingsMetrics.gearH}`);
    assert.equal(settingsMetrics.openedFromHome, true, 'Clicking ⚙️ (#openSettingsLeft) on home screen must open settings modal');
    assert.equal(settingsMetrics.opVal, 'Hüseyin', 'Settings modal must populate operator name input');
    assert.equal(settingsMetrics.langExists, true, 'Settings modal must include language selector');
    assert.equal(settingsMetrics.rulesExists, true, 'Settings modal must include rules/guide/agents quick buttons');
    assert.ok(settingsMetrics.verText.includes('2.0.0 (test)'), 'Settings modal must display server version');
    assert.equal(settingsMetrics.dirText, '/tmp/.agent-hub', 'Settings modal must display dataDir');
    assert.equal(settingsMetrics.moreText, '⋮ ' + ({ en: 'Menu', tr: 'Menü', ja: 'メニュー', ar: 'القائمة', zh: '菜单' })[settingsMetrics.lang], 'Mobile menu must follow the currently selected language');
    assert.equal(settingsMetrics.notPreventedOnMobile, true, 'Enter key on mobile must insert newline instead of submitting (#6293)');

    // Runtime language switches must update settings and accessible labels, not only the header.
    for (const [lang, operator, menu] of [
      ['en', 'Operator name', 'Menu'], ['tr', 'Operatör Adı', 'Menü'],
      ['ja', 'オペレーター名', 'メニュー'], ['ar', 'اسم المشغّل', 'القائمة'], ['zh', '操作员名称', '菜单'],
    ]) {
      const translated = await evaluate(`(() => {
        const select = document.getElementById('langSelect');
        select.value = ${JSON.stringify(lang)}; select.dispatchEvent(new Event('change'));
        const modal = document.getElementById('settingsModal');
        if (!modal.open) modal.showModal();
        return {
          operator: document.getElementById('settingsOperatorLabel').textContent,
          menu: document.getElementById('mobileMoreBtn').textContent,
          menuAria: document.getElementById('mobileMoreBtn').getAttribute('aria-label'),
          direction: document.documentElement.dir,
          modalOverflow: modal.scrollWidth - modal.clientWidth,
          labelsValid: [...document.querySelectorAll('[data-i18n]')].every(n => n.textContent && n.textContent !== 'undefined'),
        };
      })()`);
      assert.equal(translated.operator, operator);
      assert.equal(translated.menu, '⋮ ' + menu);
      assert.equal(translated.menuAria, menu);
      assert.equal(translated.direction, lang === 'ar' ? 'rtl' : 'ltr');
      assert.equal(translated.labelsValid, true);
      assert.ok(translated.modalOverflow <= 2, `${lang}: settings must not overflow horizontally on mobile`);
    }

    ws.close();
  } finally {
    chrome.kill('SIGKILL');
    localServer.closeAllConnections?.();
    await new Promise(r => localServer.close(r));
    try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }

  // --- SUBTEST D: Synthetic Server cURL Token Authorization & Real Snippet Execution ---
  const expectedToken = 'test-token-' + Math.random().toString(36).slice(2);
  const syntheticPort = 38100 + Math.floor(Math.random() * 4000);
  let lastReceivedMessage = null;

  const syntheticServer = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/messages') {
      const authHeader = req.headers['x-hub-token'];
      if (!authHeader || authHeader !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'token required' }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      lastReceivedMessage = body;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1, ...body, created_at: new Date().toISOString() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(r => syntheticServer.listen(syntheticPort, '127.0.0.1', r));

  try {
    // 1. Request WITHOUT token gets 401
    const unauthRes = await fetch(`http://127.0.0.1:${syntheticPort}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'qa', author: 'Bot', kind: 'chat', text: 'Without token' })
    });
    assert.equal(unauthRes.status, 401);
    const unauthBody = await unauthRes.json();
    assert.equal(unauthBody.error, 'token required');

    // 2. Execute the actual generated curl snippet from hubPure in a subshell with HUB_TOKEN env
    const pureCode = HTML_CONTENT.slice(HTML_CONTENT.indexOf('// hub-pure:start'), HTML_CONTENT.indexOf('// hub-pure:end'));
    const evalPure = new Function(`${pureCode}; return hubPure;`);
    const hubPure = evalPure();

    const snippet = hubPure.getAgentSnippet('api', 'qa');
    assert.ok(snippet.command.includes('X-Hub-Token:'), 'Snippet must include X-Hub-Token');
    assert.ok(!snippet.command.includes('\\$HUB_TOKEN'), 'Snippet must expand HUB_TOKEN properly without literal backslash-dollar');

    // Modify target port to synthetic server port for test execution
    const testCommand = snippet.command.replace(/http:\/\/127\.0\.0\.1:\d+/, `http://127.0.0.1:${syntheticPort}`);
    
    // Run real curl command in bash/sh with HUB_TOKEN in environment and empty HOME so token file fallback triggers
    const curlOutput = await new Promise((resolve, reject) => {
      exec(testCommand, { env: { ...process.env, HUB_TOKEN: expectedToken, HOME: tmpdir() } }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });

    const parsedRes = JSON.parse(curlOutput);
    assert.equal(parsedRes.project, 'qa');
    assert.equal(parsedRes.author, 'Bot');
    assert.equal(parsedRes.kind, 'chat');
    assert.equal(lastReceivedMessage.text, parsedRes.text);
  } finally {
    syntheticServer.closeAllConnections?.();
    await new Promise(r => syntheticServer.close(r));
  }
});
