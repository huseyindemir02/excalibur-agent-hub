import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const block = /\/\/ hub-pure:start[^\n]*\n([\s\S]*?)\n\s*\/\/ hub-pure:end/.exec(html)[1];
const hub = new Function(`${block}\nreturn hubPure;`)();

test('keyboard fit: the app shrinks to the visual viewport when the keyboard covers it', () => {
  assert.equal(hub.keyboardFit(412.4, 860), 412); // full screen, keyboard open
  assert.equal(hub.keyboardFit(860, 860), null); // no keyboard
  assert.equal(hub.keyboardFit(859.5, 860), null); // rounding noise is not a keyboard
  assert.equal(hub.keyboardFit(0, 860), null);
  assert.equal(hub.keyboardFit(undefined, 860), null);
});

test('keyboard fit: the page follows visualViewport instead of trusting 100dvh alone', () => {
  assert.match(html, /height: var\(--app-h, 100dvh\)/);
  assert.match(html, /vv\.addEventListener\('resize', fitKeyboard\)/);
  assert.match(html, /addEventListener\('fullscreenchange', fitKeyboard\)/);
  assert.match(html, /removeProperty\('--app-h'\)/);
  // innerHeight shrinks with the keyboard on Android Chrome, so it cannot be the reference
  assert.match(html, /keyboardFit\(vv\.height, layout\)/);
  assert.match(html, /const layout = document\.documentElement\.clientHeight/);
  assert.match(html, /interactive-widget=resizes-content/);
});

test('keyboard fit: the diagnostic line only appears with ?kbd=1', () => {
  assert.match(html, /get\('kbd'\) === '1' \? document\.createElement\('div'\) : null/);
});
