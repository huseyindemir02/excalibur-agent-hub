import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'hub-ag-test-'));
process.env.HUB_DATA = data;
process.env.HUB_NO_LISTEN = '1';
const port = 35000 + Math.floor(Math.random() * 20000);
process.env.HUB_PORT = String(port);

const { parseAntigravityQuota, validateUsage, scanAntigravity, ensureAgent, server } = await import('../server.mjs');

const sampleApiResponse = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            remainingFraction: 0.8506492,
            resetTime: '2026-10-21T05:39:48Z'
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            remainingFraction: 0.90689546,
            resetTime: '2026-10-15T00:13:29Z'
          }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [
          {
            bucketId: '3p-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            remainingFraction: 0.492828,
            resetTime: '2026-10-15T18:41:36Z'
          },
          {
            bucketId: '3p-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            remainingFraction: 1,
            resetTime: '2026-10-15T01:04:22Z'
          }
        ]
      }
    ]
  }
};

try {
  await test('parseAntigravityQuota parses Gemini and Claude/GPT groups with correct sorting and percentage', () => {
    const windows = parseAntigravityQuota(sampleApiResponse);
    assert.ok(Array.isArray(windows));
    assert.equal(windows.length, 4);

    assert.equal(windows[0].label, 'Gemini 5 saatlik');
    assert.equal(windows[0].percent_used, 9);
    assert.equal(windows[0].resets_at, '2026-10-15T00:13:29.000Z');

    assert.equal(windows[1].label, 'Gemini Haftalık');
    assert.equal(windows[1].percent_used, 15);
    assert.equal(windows[1].resets_at, '2026-10-21T05:39:48.000Z');

    assert.equal(windows[2].label, 'Claude/GPT 5 saatlik');
    assert.equal(windows[2].percent_used, 0);
    assert.equal(windows[2].resets_at, '2026-10-15T01:04:22.000Z');

    assert.equal(windows[3].label, 'Claude/GPT Haftalık');
    assert.equal(windows[3].percent_used, 51);
    assert.equal(windows[3].resets_at, '2026-10-15T18:41:36.000Z');
  });

  await test('parseAntigravityQuota returns null on malformed or empty responses', () => {
    assert.equal(parseAntigravityQuota(null), null);
    assert.equal(parseAntigravityQuota({}), null);
    assert.equal(parseAntigravityQuota({ response: {} }), null);
    assert.equal(parseAntigravityQuota({ response: { groups: [] } }), null);
    assert.equal(parseAntigravityQuota({ response: { groups: [{ displayName: 'Gemini', buckets: [] }] } }), null);
  });

  await test('validateUsage rejects manual submissions for Antigravity agents', () => {
    ensureAgent('Nezle02', 'antigravity');
    const err = validateUsage({ agent: 'Nezle02', raw: { plan: { status: 'ok', windows: [] } } });
    assert.equal(err, 'Antigravity limits are read automatically from local service');
  });

  await test('scanAntigravity reads local language server and populates agent_usage', async () => {
    ensureAgent('Nezle02', 'antigravity');
    await scanAntigravity();

    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const headers = { 'X-Hub-Token': readFileSync(join(data, 'token'), 'utf8').trim() };
      const res = await fetch(`http://127.0.0.1:${port}/api/usage`, { headers });
      assert.equal(res.status, 200);
      const rows = await res.json();
      const nezle = rows.find(r => r.agent === 'Nezle02');
      assert.ok(nezle, 'Nezle02 usage must exist');
      assert.equal(nezle.plan, 'Antigravity Ultra');
      assert.equal(nezle.source, 'antigravity-local');
      assert.equal(nezle.windows.length, 4);
      assert.ok(nezle.windows.some(w => w.label === 'Gemini 5 saatlik'));
      assert.ok(nezle.windows.some(w => w.label === 'Gemini Haftalık'));
      assert.ok(nezle.windows.some(w => w.label === 'Claude/GPT 5 saatlik'));
      assert.ok(nezle.windows.some(w => w.label === 'Claude/GPT Haftalık'));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await test('scanAntigravity clears windows and sets source to okunamadı when server is unreachable', async () => {
    ensureAgent('Nezle02', 'antigravity');
    // Simulate unreachable server / process not found
    await scanAntigravity(() => null);

    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const headers = { 'X-Hub-Token': readFileSync(join(data, 'token'), 'utf8').trim() };
      const res = await fetch(`http://127.0.0.1:${port}/api/usage`, { headers });
      assert.equal(res.status, 200);
      const rows = await res.json();
      const nezle = rows.find(r => r.agent === 'Nezle02');
      assert.ok(nezle, 'Nezle02 usage must exist');
      assert.equal(nezle.source, 'okunamadı');
      assert.deepEqual(nezle.windows, []);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
} finally {
  rmSync(data, { recursive: true, force: true });
}
