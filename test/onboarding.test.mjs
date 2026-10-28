import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const block = /\/\/ hub-pure:start[^\n]*\n([\s\S]*?)\n\s*\/\/ hub-pure:end/.exec(html)[1];
const hub = new Function(`${block}\nreturn hubPure;`)();

test('onboarding: getAgentSnippet generates Claude Code command and instructions', () => {
  const snip = hub.getAgentSnippet('claude', 'landing-page', 'tr');
  assert.ok(snip.command.includes('export HUB_AGENT=Claude'));
  assert.ok(snip.command.includes('HUB_TOOL=claude-code'));
  assert.ok(snip.command.includes('landing-page'));
  assert.ok(snip.command.includes('~/agent-hub/bin/hub say landing-page'));
  assert.ok(snip.instruction.includes('http://127.0.0.1:7788'));
  assert.ok(snip.note.length > 0);
});

test('onboarding: getAgentSnippet generates Antigravity command and instructions', () => {
  const snip = hub.getAgentSnippet('antigravity', 'checkout-api', 'en');
  assert.ok(snip.command.includes('export HUB_AGENT=Antigravity'));
  assert.ok(snip.command.includes('HUB_TOOL=antigravity'));
  assert.ok(snip.command.includes('checkout-api'));
  assert.ok(snip.instruction.includes('hub unread'));
});

test('onboarding: getAgentSnippet generates Cursor / Codex instructions', () => {
  const snip = hub.getAgentSnippet('cursor', 'pocket-studio', 'ja');
  assert.ok(snip.command.includes('export HUB_AGENT=Cursor'));
  assert.ok(snip.command.includes('pocket-studio'));
  assert.ok(snip.instruction.length > 0);
});

test('onboarding: getAgentSnippet generates HTTP cURL command with secure token header', () => {
  const snip = hub.getAgentSnippet('api', 'landing-page', 'zh');
  assert.ok(snip.command.includes('curl'));
  assert.ok(snip.command.includes('http://127.0.0.1:7788/api/messages'));
  assert.ok(snip.command.includes('landing-page'));
  assert.ok(snip.command.includes('X-Hub-Token'));
  assert.ok(snip.command.includes('cat ~/.agent-hub/token'));
  assert.ok(snip.instruction.includes('X-Hub-Token'));
});

test('onboarding: getAgentSnippet localizes greeting and instructions per language', () => {
  const snipEn = hub.getAgentSnippet('claude', 'landing-page', 'en');
  assert.ok(snipEn.command.includes('Hello! I am Claude'));
  assert.ok(snipEn.instruction.includes('collaborating with human operator'));

  const snipJa = hub.getAgentSnippet('claude', 'landing-page', 'ja');
  assert.ok(snipJa.command.includes('こんにちは！Claude'));
  assert.ok(snipJa.instruction.includes('人間オペレーターおよび他のAIエージェントと協調します'));

  const snipAr = hub.getAgentSnippet('claude', 'landing-page', 'ar');
  assert.ok(snipAr.command.includes('مرحباً! أنا Claude'));
  assert.ok(snipAr.instruction.includes('تنسق مع المشغل البشري'));

  const snipZh = hub.getAgentSnippet('claude', 'landing-page', 'zh');
  assert.ok(snipZh.command.includes('你好！我是 Claude'));
  assert.ok(snipZh.instruction.includes('与操作员和其他AI代理协同工作'));
});

test('onboarding: default project fallback to genel when project is empty or null', () => {
  const snipNull = hub.getAgentSnippet('claude', null, 'tr');
  assert.ok(snipNull.command.includes('genel'));

  const snipEmpty = hub.getAgentSnippet('claude', '', 'tr');
  assert.ok(snipEmpty.command.includes('genel'));
});

test('onboarding: all tabs and step guides exist across all 5 languages', () => {
  const tabs = ['quickStart', 'claude', 'antigravity', 'cursor', 'copilot', 'qwen', 'kimi', 'deepseek', 'generic', 'api'];
  for (const lang of ['tr', 'en', 'ja', 'ar', 'zh']) {
    for (const tab of tabs) {
      assert.ok(hub.I18N[lang].tabs[tab], `Tab ${tab} must have title in ${lang}`);
    }
    const steps = hub.I18N[lang].quickStartSteps;
    assert.ok(steps.step1Title && steps.step1Desc);
    assert.ok(steps.step2Title && steps.step2Desc);
    assert.ok(steps.step3Title && steps.step3Desc);
  }
});

test('onboarding: getAgentSnippet generates snippets for new popular agents', () => {
  for (const tool of ['copilot', 'qwen', 'kimi', 'deepseek', 'generic']) {
    const snip = hub.getAgentSnippet(tool, 'landing-page', 'tr');
    assert.ok(snip.command.includes('export HUB_AGENT='));
    assert.ok(snip.command.includes('HUB_TOOL='));
    assert.ok(snip.command.includes('landing-page'));
    assert.ok(snip.instruction.length > 0);
  }
});
