import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { approvalStore } from '../approvals.mjs';

test('approval queue preserves questions, orders oldest first, and resolves once atomically', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, project TEXT, kind TEXT, text TEXT, created_at TEXT, retracted_at TEXT);
      INSERT INTO messages VALUES
      (1,'one','approval','new question','2026-10-26',NULL),
      (2,'two','approval','old question','2026-10-24',NULL),
      (3,'one','request','not an approval','2026-10-23',NULL),
      (4,'one','approval','withdrawn','2026-10-22','2026-10-23');`);
    const store = approvalStore(db);
    assert.deepEqual(store.pending().map(m => m.id), [2, 1]);
    const answer = row => {
      db.prepare('INSERT INTO messages VALUES (5,?,?,?, ?,NULL)').run(row.project, 'chat', 'Synthetic answer', '2026-10-27');
      return { id: 5, created_at: '2026-10-27' };
    };
    store.resolve(2, 'approve', answer);
    assert.deepEqual(store.pending().map(m => m.id), [1]);
    assert.equal(db.prepare('SELECT text FROM messages WHERE id=2').get().text, 'old question');
    assert.equal(db.prepare('SELECT project FROM messages WHERE id=5').get().project, 'two');
    assert.throws(() => store.resolve(2, 'reject', () => assert.fail('must not duplicate answer')), { status: 409 });
    assert.throws(() => store.resolve(3, 'reply', answer), { status: 404 });
    assert.throws(() => store.resolve(4, 'approve', answer), { status: 404 });
    assert.throws(() => store.resolve(1, 'invalid', answer), { status: 422 });
    assert.throws(() => store.resolve(1, 'reply', row => {
      db.prepare('INSERT INTO messages VALUES (6,?,?,?, ?,NULL)').run(row.project, 'chat', 'rolled back', '2026-10-28');
      throw new Error('write failed');
    }), /write failed/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id=6').get().n, 0);
    assert.deepEqual(store.pending().map(m => m.id), [1]);
  } finally { db.close(); }
});
