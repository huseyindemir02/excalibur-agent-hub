import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEDULE_I18N, scheduleText } from '../schedule-i18n.mjs';

test('schedule: all five languages translate values, default, updated and unavailable state', () => {
  for (const [lang, strings] of Object.entries(SCHEDULE_I18N)) {
    const normal = scheduleText({ checkMinutes: 20, heartbeatMinutes: 45, updatedAt: null }, lang);
    assert.ok(normal.lines[0].includes('20') && normal.lines[0].includes('45'));
    assert.ok(normal.lines[0].includes(strings[2]));
    assert.equal(normal.lines[1], strings[3]);
    assert.doesNotMatch(normal.lines.join('\n'), /\{\w+\}/);
    const updated = scheduleText({ checkMinutes: 30, heartbeatMinutes: 60, updatedAt: '2026-10-27T10:00:00Z' }, lang);
    assert.ok(updated.lines[0].includes('2026'));
    assert.equal(scheduleText(null, lang).error, strings[4]);
  }
  assert.deepEqual(scheduleText(null, 'unknown'), scheduleText(null, 'en'));
});
