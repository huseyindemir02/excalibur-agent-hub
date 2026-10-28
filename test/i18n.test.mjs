import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const block = /\/\/ hub-pure:start[^\n]*\n([\s\S]*?)\n\s*\/\/ hub-pure:end/.exec(html)[1];
const hub = new Function(`${block}\nreturn hubPure;`)();

test('i18n: supported languages list contains TR, EN, JA, AR, ZH', () => {
  const codes = hub.SUPPORTED_LANGS.map(l => l.code);
  assert.deepEqual(codes, ['tr', 'en', 'ja', 'ar', 'zh']);
  for (const lang of hub.SUPPORTED_LANGS) {
    assert.ok(lang.label, `Language ${lang.code} should have a label`);
    assert.ok(lang.flag, `Language ${lang.code} should have a flag`);
    assert.ok(lang.dir === 'ltr' || lang.dir === 'rtl', `Language ${lang.code} direction should be ltr or rtl`);
  }
});

test('i18n: RTL detection handles Arabic correctly and others as LTR', () => {
  assert.equal(hub.isRtl('ar'), true);
  assert.equal(hub.isRtl('tr'), false);
  assert.equal(hub.isRtl('en'), false);
  assert.equal(hub.isRtl('ja'), false);
  assert.equal(hub.isRtl('zh'), false);
  assert.equal(hub.isRtl('unknown'), false);
});

test('i18n: locale mappings for date and time formatting', () => {
  assert.equal(hub.fmtLocale('tr'), 'tr-TR');
  assert.equal(hub.fmtLocale('en'), 'en-US');
  assert.equal(hub.fmtLocale('ja'), 'ja-JP');
  assert.equal(hub.fmtLocale('ar'), 'ar-SA');
  assert.equal(hub.fmtLocale('zh'), 'zh-CN');
});

test('i18n: translation dictionaries completeness across all 5 languages', () => {
  const tr = hub.I18N.tr;
  assert.ok(tr, 'Turkish dictionary must exist');

  const topKeys = Object.keys(tr);
  const requiredLangs = ['en', 'ja', 'ar', 'zh'];

  for (const lang of requiredLangs) {
    const dict = hub.I18N[lang];
    assert.ok(dict, `Dictionary for '${lang}' must exist`);

    for (const key of topKeys) {
      if (typeof tr[key] === 'object' && tr[key] !== null) {
        assert.ok(dict[key], `Nested object '${key}' must exist in '${lang}'`);
        for (const subKey of Object.keys(tr[key])) {
          assert.ok(
            dict[key][subKey] !== undefined && dict[key][subKey] !== '',
            `Key '${key}.${subKey}' is missing or empty in '${lang}'`
          );
        }
      } else {
        assert.ok(
          dict[key] !== undefined && dict[key] !== '',
          `Key '${key}' is missing or empty in '${lang}'`
        );
      }
    }
  }
});

test('i18n: hub.t parameter replacement and fallback behavior', () => {
  assert.equal(hub.t('statusError', 'en', { msg: 'timeout' }), 'error: timeout');
  assert.equal(hub.t('statusError', 'tr', { msg: 'zaman aşımı' }), 'hata: zaman aşımı');
  assert.equal(hub.t('statusError', 'ja', { msg: 'タイムアウト' }), 'エラー: タイムアウト');
  assert.equal(hub.t('statusError', 'ar', { msg: 'انتهت المهلة' }), 'خطأ: انتهت المهلة');
  assert.equal(hub.t('statusError', 'zh', { msg: '超时' }), '错误: 超时');

  // Fallback to English/Turkish for missing key or unknown language
  assert.equal(hub.t('projects', 'unknown'), 'Projeler');
});

test('i18n: message kinds translations for all 10 standard kinds', () => {
  const kinds = ['chat', 'command', 'note', 'request', 'ack', 'claim', 'done', 'heartbeat', 'conflict', 'takeover'];
  for (const lang of ['tr', 'en', 'ja', 'ar', 'zh']) {
    for (const k of kinds) {
      const translated = hub.tKind(k, lang);
      assert.ok(translated && translated.length > 0, `Kind '${k}' must have translation in '${lang}'`);
    }
  }
});

test('i18n: projectDisplayName localizes koordinasyon while preserving slug and custom titles', () => {
  assert.equal(hub.projectDisplayName('koordinasyon', 'tr'), 'Koordinasyon');
  assert.equal(hub.projectDisplayName('koordinasyon', 'en'), 'Coordination');
  assert.equal(hub.projectDisplayName('koordinasyon', 'ja'), '調整');
  assert.equal(hub.projectDisplayName('koordinasyon', 'ar'), 'التنسيق');
  assert.equal(hub.projectDisplayName('koordinasyon', 'zh'), '协调');

  // Object forms
  assert.equal(hub.projectDisplayName({ slug: 'koordinasyon', title: 'Koordinasyon' }, 'en'), 'Coordination');
  assert.equal(hub.projectDisplayName({ slug: 'koordinasyon', title: 'Koordinasyon' }, 'ja'), '調整');
  assert.equal(hub.projectDisplayName({ slug: 'custom-proj', title: 'Custom Title' }, 'en'), 'Custom Title');
  assert.equal(hub.projectDisplayName({ slug: 'checkout-api' }, 'en'), 'checkout-api');
});

test('i18n: every static text and accessibility translation has a complete key and matching parameters', () => {
  const keys = [...html.matchAll(/data-i18n(?:-aria-label|-title|-placeholder)?="([^"]+)"/g)].map(m => m[1]);
  assert.ok(keys.length > 90, 'covers the former static HTML labels and attributes');
  for (const key of keys) for (const { code } of hub.SUPPORTED_LANGS) {
    assert.equal(typeof hub.I18N[code][key], 'string', `${code}.${key}`);
    assert.ok(hub.t(key, code));
  }
  const params = value => [...String(value).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [key, value] of Object.entries(hub.I18N.en)) {
    if (typeof value !== 'string') continue;
    for (const { code } of hub.SUPPORTED_LANGS) assert.deepEqual(params(hub.I18N[code][key]), params(value), `${code}.${key}`);
  }
});

test('i18n: usage percentage ordering and application metadata follow the language', () => {
  assert.equal(hub.t('limitUsed', 'en', { pct: 42, rem: 58 }), '42% used · 58% remaining');
  assert.equal(hub.t('limitUsed', 'tr', { pct: 42, rem: 58 }), '%42 kullanıldı · %58 kalan');
  for (const { code } of hub.SUPPORTED_LANGS) {
    assert.ok(hub.t('messageCount', code, { n: 5 }).includes('5'));
    assert.ok(hub.t('addedBy', code, { name: '<literal>' }).includes('<literal>'));
    assert.ok(hub.t('projectOnly', code, { project: 'synthetic-project' }).includes('synthetic-project'));
    assert.ok(!hub.t('limitUsed', code, { pct: 42, rem: 58 }).includes('{'));
  }
});
