/** Resolution metadata only: the question and answer remain ordinary messages in their project. */
export function approvalStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS approval_resolutions (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id),
    response_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
    decision TEXT NOT NULL CHECK(decision IN ('approve','reject','reply')),
    resolved_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_approval_queue ON messages(kind, created_at, id);`);
  const pending = db.prepare(`SELECT m.* FROM messages m
    LEFT JOIN approval_resolutions r ON r.message_id = m.id
    WHERE m.kind = 'approval' AND m.retracted_at IS NULL AND r.message_id IS NULL
    ORDER BY m.created_at ASC, m.id ASC`);
  const question = db.prepare("SELECT * FROM messages WHERE id = ? AND kind = 'approval' AND retracted_at IS NULL");
  const resolved = db.prepare('SELECT * FROM approval_resolutions WHERE message_id = ?');
  const insert = db.prepare('INSERT INTO approval_resolutions(message_id, response_id, decision, resolved_at) VALUES (?, ?, ?, ?)');
  function fail(status, message) { throw Object.assign(new Error(message), { status }); }
  return {
    pending: () => pending.all(),
    resolve(id, decision, writeAnswer) {
      if (!Number.isSafeInteger(id) || id < 1) fail(422, 'valid approval id required');
      if (!['approve', 'reject', 'reply'].includes(decision)) fail(422, 'invalid decision');
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = question.get(id);
        if (!row) fail(404, 'approval not found');
        if (resolved.get(id)) fail(409, 'approval already answered');
        // Must only write within this SQLite transaction; announce to clients after COMMIT.
        const answer = writeAnswer(row);
        insert.run(id, answer.id, decision, answer.created_at);
        db.exec('COMMIT');
        return answer;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

/** Mutations use the same local operator-browser boundary as message retraction. */
export function approvalResolution({ store, human, readJson, post, announce, send }) {
  const replies = {
    tr: ['Onaylandı.', 'Reddedildi.'], en: ['Approved.', 'Rejected.'],
    ja: ['承認しました。', '却下しました。'], ar: ['تمت الموافقة.', 'تم الرفض.'], zh: ['已批准。', '已拒绝。'],
  };
  return async (req, res, origin) => {
    const body = await readJson(req);
    if (body.as !== human || req.headers['x-hub-token'] || req.headers.origin !== origin || !req.headers.cookie) {
      return send(res, 403, { error: 'only the operator in the Hub browser can answer approvals' });
    }
    const id = body.id;
    const decision = body.decision;
    const supplied = body.text;
    if (supplied !== undefined && (typeof supplied !== 'string' || supplied.length > 8000)) return send(res, 422, { error: 'reply must be text, max 8000 chars' });
    const texts = replies[body.lang] || replies.en;
    const text = decision === 'reply' ? (supplied || '').trim() : texts[decision === 'approve' ? 0 : 1];
    if (!text) return send(res, 422, { error: 'reply text required' });
    try {
      const answer = store.resolve(id, decision, question => post({
        project: question.project, author: human, kind: 'chat', text,
        to: question.author, topic: question.topic, files: [], replyTo: question.id, source: 'chat',
      }));
      announce(answer);
      return send(res, 201, answer);
    } catch (error) {
      if (error.status) return send(res, error.status, { error: error.message });
      throw error;
    }
  };
}
