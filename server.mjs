// Agent Hub — local chat room where AI agents and the operator coordinate, one tab per project.
// Zero dependencies (Node >= 22). Loopback by default; optional LAN access requires pairing.
import { createServer } from 'node:http';
import { pairingGuard, isLocalBrowser } from './pairing.mjs';
import { approvalStore, approvalResolution } from './approvals.mjs';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.HUB_DATA || join(homedir(), '.agent-hub');
const CONFIG_FILE = join(DATA, 'config.json');

function getLocalIps(interfaces = null) {
  const ips = [];
  try {
    const nets = interfaces || networkInterfaces();
    for (const name of Object.keys(nets)) {
      // VPN, tunnel and peer-to-peer addresses are not phone LAN destinations.
      if (/^(utun|tun|tap|wg|ppp|ipsec|awdl|llw|docker|veth|virbr)/i.test(name)) continue;
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal && !ips.includes(net.address)) ips.push(net.address);
      }
    }
  } catch {}
  return ips;
}

function readConfig() {
  let cfg = { port: 7788, lan: false };
  try {
    if (existsSync(CONFIG_FILE)) {
      cfg = { ...cfg, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch {}
  return cfg;
}

// Advisory check/heartbeat interval published to agents; each agent runs its own timer (the hub cannot force it).
const SCHEDULE_LIMITS = { checkMinutes: [5, 240, 30], heartbeatMinutes: [15, 480, 60] };
export function agentSchedule(cfg = readConfig()) {
  const v = k => Number.isInteger(cfg[k]) ? cfg[k] : SCHEDULE_LIMITS[k][2];
  return { checkMinutes: v('checkMinutes'), heartbeatMinutes: v('heartbeatMinutes'), advisory: true, updatedAt: cfg.scheduleUpdatedAt || null };
}
/** Merge requested schedule fields over the current ones; returns updates or an error string. */
export function validateSchedule(body, current = agentSchedule()) {
  const next = { checkMinutes: current.checkMinutes, heartbeatMinutes: current.heartbeatMinutes };
  for (const [k, [min, max]] of Object.entries(SCHEDULE_LIMITS)) {
    if (body[k] === undefined) continue;
    const n = Number(body[k]);
    if (body[k] === null || body[k] === '' || !Number.isInteger(n) || n < min || n > max) return `${k} must be a whole number of minutes between ${min} and ${max}`;
    next[k] = n;
  }
  if (next.heartbeatMinutes < next.checkMinutes) return `heartbeatMinutes (${next.heartbeatMinutes}) must be at least checkMinutes (${next.checkMinutes})`;
  if (next.checkMinutes === current.checkMinutes && next.heartbeatMinutes === current.heartbeatMinutes) return {};
  return { ...next, scheduleUpdatedAt: new Date().toISOString() };
}

function writeConfig(newCfg) {
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const current = readConfig();
  const merged = { ...current, ...newCfg };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

const config = readConfig();
const PORT = Number(process.env.HUB_PORT || config.port || 7788);
const LAN_MODE = process.env.HUB_LAN === '1' ? true : (process.env.HUB_LAN === '0' ? false : Boolean(config.lan));
const FILES = join(DATA, 'files');
const HERE = dirname(fileURLToPath(import.meta.url));
const HUB_VERSION = (() => {
  try {
    const sha = execFileSync('git', ['-C', HERE, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return sha ? `2.0.0 (${sha})` : '2.0.0';
  } catch {
    return '2.0.0';
  }
})();

const localIps = getLocalIps();
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
if (LAN_MODE) {
  for (const ip of localIps) {
    ALLOWED_HOSTS.add(`${ip}:${PORT}`);
  }
}
const LISTEN_HOST = LAN_MODE ? '0.0.0.0' : '127.0.0.1';

export const KINDS = ['approval', 'chat', 'command', 'request', 'ack', 'claim', 'done', 'heartbeat', 'note', 'conflict', 'takeover'];
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u;
const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FILE_ID_RE = /^[a-f0-9]{24}$/;
const MAX_TEXT = 8000;
const MAX_FILE = 50 * 1024 * 1024;
const PALETTE = ['#2563eb', '#16a34a', '#c026d3', '#ea580c', '#0891b2', '#9333ea', '#ca8a04', '#db2777', '#4f46e5', '#0d9488', '#65a30d', '#b45309'];

// Allowed uploads. Images are shown inline only when their bytes match; everything else downloads.
// No SVG/HTML: they could run script on this origin.
const UPLOAD_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip',
};
const MAGIC = {
  png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff], gif: [0x47, 0x49, 0x46, 0x38],
  webp: [0x52, 0x49, 0x46, 0x46], pdf: [0x25, 0x50, 0x44, 0x46],
};

mkdirSync(FILES, { recursive: true, mode: 0o700 });
const tokenFile = join(DATA, 'token');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex') + '\n', { mode: 0o600 });
chmodSync(tokenFile, 0o600);
const TOKEN = readFileSync(tokenFile, 'utf8').trim();

const db = new DatabaseSync(join(DATA, 'hub.db'));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat',
  to_agent TEXT, topic TEXT, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_project_id ON messages(project, id);
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY, color TEXT NOT NULL, tool TEXT, is_human INTEGER NOT NULL DEFAULT 0, last_seen TEXT, retired INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, title TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_usage (agent TEXT PRIMARY KEY, plan TEXT, windows TEXT NOT NULL, note TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL,
  uploader TEXT NOT NULL, inline INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Nasıl çalışırız',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rules_order ON rules(sort_order, id);
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, author, emoji)
);
CREATE INDEX IF NOT EXISTS message_reactions_msg ON message_reactions(message_id);
DROP TABLE IF EXISTS usage;`);
for (const [table, col, type] of [['messages', 'source', "TEXT NOT NULL DEFAULT 'legacy'"], ['messages', 'retracted_at', 'TEXT'], ['messages', 'retracted_by', 'TEXT'], ['files', 'revoked_at', 'TEXT'], ['messages', 'files', 'TEXT'], ['messages', 'reply_to', 'INTEGER'], ['agents', 'role', 'TEXT'], ['agents', 'avatar', 'TEXT'], ['agents', 'retired', 'INTEGER NOT NULL DEFAULT 0'], ['agent_usage', 'source', 'TEXT'], ['projects', 'pinned', 'INTEGER NOT NULL DEFAULT 0'], ['projects', 'archived', 'INTEGER NOT NULL DEFAULT 0'], ['projects', 'deleted_at', 'TEXT'], ['rules', 'project', 'TEXT']]) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

// Preserve the registered operator on upgrades that predate config.json.
// A fresh database has no human row and uses the neutral default.
const existingHuman = db.prepare('SELECT name FROM agents WHERE is_human = 1 AND retired = 0 ORDER BY rowid LIMIT 1').get()?.name;
export const HUMAN = (process.env.HUB_HUMAN || config.operator || existingHuman || 'Operator').trim();

const now = () => new Date().toISOString();
// Personal UI inbox is separate from agent unread: CLI still receives operator commands/logs.
db.function('mentioned', { deterministic: true }, (text, name) => {
  const targets = [String(name).normalize('NFC').toLocaleLowerCase('tr-TR'), 'herkes', 'all'];
  return [...String(text || '').matchAll(/@[\p{L}\p{N}_.-]+/gu)].some(x => targets.includes(x[0].slice(1).replace(/\.+$/, '').normalize('NFC').toLocaleLowerCase('tr-TR'))) ? 1 : 0;
});
const q = {
  agent: db.prepare('SELECT * FROM agents WHERE name = ?'),
  agents: db.prepare(`SELECT * FROM agents WHERE retired = 0 ORDER BY is_human DESC, (role = 'coordinator') DESC, name`),
  allAgents: db.prepare(`SELECT * FROM agents ORDER BY is_human DESC, (role = 'coordinator') DESC, name`),
  coordinator: db.prepare(`SELECT name FROM agents WHERE role = 'coordinator' AND retired = 0`),
  setRetired: db.prepare('UPDATE agents SET retired = ? WHERE name = ?'),
  clearCoordinator: db.prepare(`UPDATE agents SET role = NULL WHERE role = 'coordinator'`),
  setRole: db.prepare('UPDATE agents SET role = ? WHERE name = ?'),
  setAvatar: db.prepare('UPDATE agents SET avatar = ? WHERE name = ?'),
  agentCount: db.prepare('SELECT COUNT(*) AS n FROM agents'),
  addAgent: db.prepare('INSERT INTO agents (name, color, tool, is_human, last_seen) VALUES (?, ?, ?, ?, ?)'),
  seen: db.prepare('UPDATE agents SET last_seen = ?, tool = COALESCE(?, tool) WHERE name = ? AND retired = 0'),
  setColor: db.prepare('UPDATE agents SET color = ? WHERE name = ?'),
  byTool: db.prepare('SELECT name FROM agents WHERE tool = ? AND retired = 0'),
  project: db.prepare('SELECT * FROM projects WHERE slug = ?'),
  // Deleted chats are hidden, not erased: their messages stay in the database.
  projects: db.prepare(`SELECT p.slug, p.title, p.pinned, p.archived, MAX(m.id) AS last_id, COUNT(m.id) AS count
    FROM projects p LEFT JOIN messages m ON m.project = p.slug WHERE p.deleted_at IS NULL
    GROUP BY p.slug ORDER BY p.pinned DESC, last_id DESC, p.slug`),
  setProjectState: db.prepare('UPDATE projects SET pinned = COALESCE(?, pinned), archived = COALESCE(?, archived), deleted_at = ? WHERE slug = ?'),
  undeleteProject: db.prepare('UPDATE projects SET deleted_at = NULL, archived = 0 WHERE slug = ? AND (deleted_at IS NOT NULL OR archived != 0)'),
  addProject: db.prepare('INSERT INTO projects (slug, title, created_at) VALUES (?, ?, ?)'),
  add: db.prepare('INSERT INTO messages (project, author, kind, to_agent, topic, text, files, reply_to, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  retract: db.prepare('UPDATE messages SET retracted_at = ?, retracted_by = ? WHERE id = ? AND retracted_at IS NULL'),
  revokeFile: db.prepare('UPDATE files SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?'),
  byId: db.prepare('SELECT * FROM messages WHERE id = ?'),
  list: db.prepare('SELECT * FROM messages WHERE project = ? AND id > ? ORDER BY id DESC LIMIT ?'),
  usage: db.prepare(`SELECT u.* FROM agent_usage u LEFT JOIN agents a ON a.name = u.agent WHERE COALESCE(a.retired, 0) = 0 ORDER BY u.agent`),
  setUsage: db.prepare(`INSERT INTO agent_usage (agent, plan, windows, note, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent) DO UPDATE SET plan = excluded.plan, windows = excluded.windows, note = excluded.note, source = excluded.source, updated_at = excluded.updated_at`),
  file: db.prepare('SELECT * FROM files WHERE id = ?'),
  addFile: db.prepare('INSERT INTO files (id, name, ext, size, uploader, inline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  personalInbox: db.prepare(`SELECT * FROM messages WHERE id > ? AND author <> ? AND kind <> 'heartbeat'
    AND (to_agent = ? OR mentioned(text, ?) = 1
      OR reply_to IN (SELECT id FROM messages WHERE author = ?)) ORDER BY id DESC LIMIT ?`),
  inbox: db.prepare(`SELECT * FROM messages WHERE id > ? AND author <> ?
    AND (to_agent = ? OR to_agent = 'all' OR kind = 'command' OR author = '${HUMAN}' OR instr(lower(text), lower('@' || ?)) > 0
      OR reply_to IN (SELECT id FROM messages WHERE author = ?))
    ORDER BY id LIMIT ?`),
  waitInbox: db.prepare(`SELECT * FROM messages m WHERE id > ? AND author <> ? AND retracted_at IS NULL
    AND (? IS NULL OR project = ?)
    AND (to_agent = ? OR mentioned(text, ?) = 1
      OR reply_to IN (SELECT id FROM messages WHERE author = ?)
      OR (author = ? AND EXISTS (SELECT 1 FROM agents WHERE name = ? AND role = 'coordinator' AND retired = 0)))
    ORDER BY id LIMIT 200`),
  openClaim: db.prepare(`SELECT c.* FROM messages c WHERE c.project = ? AND c.topic = ?
    AND c.kind = 'claim' AND c.author <> ? AND c.created_at > ? AND c.retracted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM messages end WHERE end.project = c.project AND end.topic = c.topic
      AND end.id > c.id AND end.kind IN ('done', 'takeover') AND end.retracted_at IS NULL)
    ORDER BY c.id DESC LIMIT 1`),
  rules: db.prepare('SELECT * FROM rules ORDER BY sort_order ASC, id ASC'),
  rulesByProject: db.prepare('SELECT * FROM rules WHERE project IS NULL OR project = \'\' OR project = ? ORDER BY sort_order ASC, id ASC'),
  ruleById: db.prepare('SELECT * FROM rules WHERE id = ?'),
  addRule: db.prepare('INSERT INTO rules (text, category, created_by, created_at, updated_at, sort_order, project) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateRule: db.prepare('UPDATE rules SET text = ?, category = ?, sort_order = ?, updated_at = ?, project = ? WHERE id = ?'),
  deleteRule: db.prepare('DELETE FROM rules WHERE id = ?'),
  maxRuleOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM rules'),
  countRules: db.prepare('SELECT COUNT(*) AS c FROM rules'),
  reactionsByMsg: db.prepare('SELECT author, emoji FROM message_reactions WHERE message_id = ? ORDER BY created_at ASC, rowid ASC'),
  hasReaction: db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND author = ? AND emoji = ?'),
  addReaction: db.prepare('INSERT INTO message_reactions (message_id, author, emoji, created_at) VALUES (?, ?, ?, ?)'),
  removeReaction: db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND author = ? AND emoji = ?'),
  clearReactions: db.prepare('DELETE FROM message_reactions WHERE message_id = ?'),
};

const approvals = approvalStore(db);
const resolveApproval = approvalResolution({ store: approvals, human: HUMAN, readJson,
  post: m => post(m, null, false), send,
  announce: row => { broadcast('message', row); broadcast('agents', q.agents.all()); broadcast('approvals', {}); },
});

function seedRules() {
  if (q.countRules.get().c > 0) return;
  let content = '';
  try { content = readFileSync(join(new URL('.', import.meta.url).pathname, 'RULES.md'), 'utf8'); } catch {}
  if (!content) {
    try { content = readFileSync(join(DATA, 'RULES.md'), 'utf8'); } catch {}
  }
  const lines = content ? content.split('\n') : [];
  let currentCategory = 'How we work';
  let order = 1;
  const currentNow = now();
  db.exec('BEGIN TRANSACTION');
  try {
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith('## ')) {
        currentCategory = line.slice(3).trim();
      } else if (/^\d+\.\s+/.test(line)) {
        const text = line.replace(/^\d+\.\s+/, '').trim();
        q.addRule.run(text, currentCategory, 'setup', currentNow, currentNow, order++, null);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('failed to seed rules:', e);
  }
}
seedRules();

function ensureCoordinationProject() {
  // Existing installs keep their 'koordinasyon' channel; a new install starts with an English one.
  if (q.project.get('koordinasyon') || q.project.get('coordination')) return;
  const count = db.prepare('SELECT COUNT(*) AS c FROM projects').get()?.c || 0;
  if (count === 0) {
    db.prepare('INSERT INTO projects (slug, title, pinned, created_at) VALUES (?, ?, 1, ?)').run('coordination', 'Coordination', now());
  }
}
ensureCoordinationProject();
// Original content stays in SQLite for audit; all outward views use this projection.
const RETRACTED = 'Bu mesaj geri alındı';
const ALLOWED_REACTIONS = new Set(['👍', '❤️', '🔥', '🎉', '👀', '🚀', '✅', '🙏']);
function reactionsFor(id) {
  const rows = q.reactionsByMsg.all(id);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.emoji)) map.set(r.emoji, []);
    map.get(r.emoji).push(r.author);
  }
  return [...map.entries()].map(([emoji, authors]) => ({ emoji, count: authors.length, authors }));
}
const canRetractSource = row => row.source === 'chat' || (row.source === 'legacy' && row.kind === 'chat');
const withFiles = (row) => {
  if (!row) return row;
  const parent = row.reply_to ? q.byId.get(row.reply_to) : null;
  const retracted = !!row.retracted_at;
  return { ...row, text: retracted ? RETRACTED : row.text,
    topic: retracted ? null : row.topic, to_agent: retracted ? null : row.to_agent,
    files: retracted ? [] : (row.files ? JSON.parse(row.files) : []).filter(f => !q.file.get(f.id)?.revoked_at),
    reactions: retracted ? [] : reactionsFor(row.id),
    retractable: !retracted && canRetractSource(row),
    revoked_file_ids: retracted ? (row.files ? JSON.parse(row.files) : []).map(f => f.id) : [],
    reply: !retracted && parent ? { id: parent.id, author: parent.author,
      text: parent.retracted_at ? RETRACTED : (parent.text || '📎').slice(0, 160) } : null };
};

function ensureAgent(name, tool = null) {
  const existing = q.agent.get(name);
  if (!existing) {
    const isHuman = name === HUMAN ? 1 : 0;
    const color = isHuman ? '#111827' : PALETTE[q.agentCount.get().n % PALETTE.length];
    q.addAgent.run(name, color, tool, isHuman, now());
  } else if (!existing.retired) {
    q.seen.run(now(), tool, name);
  }
}
function ensureProject(slug, announce = true) {
  if (!q.project.get(slug)) q.addProject.run(slug, slug, now());
  // A new message brings a deleted chat back, so nothing posted to it is ever hidden.
  else if (q.undeleteProject.run(slug).changes && announce) broadcast('projects', q.projects.all());
}
ensureAgent(HUMAN);

// Live updates: Server-Sent Events.
const clients = new Set();
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

function tokenOk(req) {
  const header = req.headers['x-hub-token'];
  const cookie = /(?:^|;\s*)hub=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  const given = Buffer.from(String(header || cookie || ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store', ...extra,
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

const pairing = pairingGuard();
if (LAN_MODE) pairing.current();

function pagePairing() {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Hub — Eşleştirme / Pairing</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0b141a; color: #e9edef; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 16px;
  }
  .card {
    background: #111b21; border: 1px solid #222e35; border-radius: 12px; padding: 32px 24px; max-width: 400px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.6); text-align: center;
  }
  .icon { font-size: 40px; margin-bottom: 12px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #00a884; }
  p { font-size: 14px; color: #8696a0; line-height: 1.5; margin-bottom: 20px; }
  .code-input {
    width: 100%; font-size: 28px; letter-spacing: 6px; text-align: center; font-family: monospace; font-weight: bold;
    padding: 12px; border: 2px solid #2a3942; border-radius: 8px; background: #202c33; color: #fff; margin-bottom: 16px; outline: none;
  }
  .code-input:focus { border-color: #00a884; }
  .btn {
    width: 100%; min-height: 44px; padding: 12px; font-size: 15px; font-weight: 600; border-radius: 8px; border: none; background: #00a884; color: #111b21; cursor: pointer; transition: background .15s;
  }
  .btn:hover { background: #06cf9c; }
  #pairStatus { color: #ff859b; font-size: 14px; margin-bottom: 12px; }
  select { min-height: 44px; background: #202c33; color: #e9edef; border-radius: 6px; margin-bottom: 16px; }
  .sub-note { font-size: 12px; color: #667781; margin-top: 20px; line-height: 1.4; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">🔒</div>
  <h1>Agent Hub</h1>
  <select id="pairLanguage" aria-label="Language"><option value="tr">Türkçe</option><option value="en">English</option><option value="ja">日本語</option><option value="ar">العربية</option><option value="zh">中文</option></select>
  <p id="pairPrompt">Enter the 6-digit pairing code from Settings on your computer.</p>
  <div id="pairStatus" role="status" aria-live="polite"></div>
  <form method="POST" action="/pair">
    <input type="text" name="code" aria-label="Eşleştirme kodu / Pairing code" autocomplete="one-time-code" class="code-input" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="••• •••" autofocus required>
    <button type="submit" class="btn">Bağlan / Connect</button>
  </form>
  <div class="sub-note" id="pairNote">Or scan the QR code on your computer screen.</div>
</div>
<script>
(() => {
  const form = document.querySelector('form');
  const input = form.elements.code;
  const status = document.getElementById('pairStatus');
  const button = form.querySelector('button');
  const translations = {
    tr: ['Bilgisayarınızdaki Ayarlar ekranından 6 haneli kodu girin.', 'Bağlan', 'Ya da bilgisayardaki QR kodu okutun.', 'Çok fazla deneme; bir dakika bekleyin.', 'Kod geçersiz veya süresi dolmuş. Bilgisayarda Ayarlar ekranını yeniden açın.', 'Bağlantı kurulamadı; tekrar deneyin.'],
    en: ['Enter the 6-digit code from Settings on your computer.', 'Connect', 'Or scan the QR code on your computer screen.', 'Too many attempts; wait one minute.', 'Invalid or expired code. Reopen Settings on your computer.', 'Connection failed; please retry.'],
    ja: ['パソコンの設定画面にある6桁のコードを入力してください。', '接続', 'またはパソコンのQRコードを読み取ってください。', '試行回数が多すぎます。1分待ってください。', 'コードが無効か期限切れです。パソコンの設定を開き直してください。', '接続できませんでした。もう一度お試しください。'],
    ar: ['أدخل الرمز المكون من 6 أرقام من إعدادات الكمبيوتر.', 'اتصال', 'أو امسح رمز QR على شاشة الكمبيوتر.', 'محاولات كثيرة؛ انتظر دقيقة واحدة.', 'الرمز غير صالح أو منتهي. أعد فتح الإعدادات على الكمبيوتر.', 'فشل الاتصال؛ حاول مجدداً.'],
    zh: ['输入电脑设置中的6位配对码。', '连接', '或扫描电脑屏幕上的二维码。', '尝试次数过多；请等待一分钟。', '配对码无效或已过期。请重新打开电脑设置。', '连接失败；请重试。'],
  };
  const language = document.getElementById('pairLanguage');
  let saved;
  try { saved = localStorage.getItem('hub.lang'); } catch {}
  language.value = translations[saved] ? saved : (translations[navigator.language.slice(0,2)] ? navigator.language.slice(0,2) : 'en');
  let words;
  function translate() {
    words = translations[language.value];
    document.documentElement.lang = language.value;
    document.documentElement.dir = language.value === 'ar' ? 'rtl' : 'ltr';
    document.getElementById('pairPrompt').textContent = words[0];
    input.setAttribute('aria-label', words[0]);
    button.textContent = words[1];
    document.getElementById('pairNote').textContent = words[2];
    status.textContent = '';
  }
  language.onchange = () => { translate(); try { localStorage.setItem('hub.lang', language.value); } catch {} };
  translate();
  const fragmentCode = new URLSearchParams(location.hash.slice(1)).get('pair');
  history.replaceState(null, '', location.pathname);
  let busy = false;
  async function pair(event) {
    event?.preventDefault();
    if (busy) return;
    busy = true; button.disabled = true; status.textContent = '';
    try {
      const response = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: input.value }) });
      if (response.ok) { location.replace('/'); return; }
      status.textContent = response.status === 429 ? words[3] : words[4];
    } catch { status.textContent = words[5]; }
    busy = false; button.disabled = false;
  }
  form.addEventListener('submit', pair);
  if (/^[0-9]{6}$/.test(fragmentCode || '')) { input.value = fragmentCode; pair(); }
})();
</script>
</body>
</html>`;
}

async function readBody(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('content-type must be application/json');
  return JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
}

export function validateMessage(b) {
  const author = String(b.author || '').trim();
  const project = String(b.project || '').trim().toLowerCase();
  const rawKind = String(b.kind || 'chat').toLowerCase();
  const kind = rawKind === 'onay' ? 'approval' : rawKind;
  const text = String(b.text || '').trim();
  const to = b.to ? String(b.to).trim() : null;
  const topic = b.topic ? String(b.topic).trim().slice(0, 80) : null;
  const fileIds = Array.isArray(b.files) ? b.files.map(String) : [];
  if (!NAME_RE.test(author)) return 'invalid author';
  if (!PROJECT_RE.test(project)) return 'invalid project (a-z, 0-9, -)';
  if (kind === 'approval' && !text) return 'approval question required';
  if (!KINDS.includes(kind)) return `invalid kind (${KINDS.join(', ')})`;
  if (!text && !fileIds.length) return `text or file required, max ${MAX_TEXT} chars`;
  if (text.length > MAX_TEXT) return `message is ${text.length} characters; the limit is ${MAX_TEXT}. Send the text as a file: hub say ${project} "<short summary>" --file <path>`;
  if (kind === 'approval' && to && to !== HUMAN) return 'approvals must address the operator';
  if (to && to !== 'all' && !NAME_RE.test(to)) return 'invalid to';
  if (fileIds.length > 20) return 'max 20 files';
  const replyTo = b.reply_to ? Number(b.reply_to) : null;
  if (replyTo !== null) {
    const parent = Number.isInteger(replyTo) ? q.byId.get(replyTo) : null;
    if (!parent || parent.project !== project) return 'reply_to must be a message in the same project';
  }
  const files = [];
  for (const id of fileIds) {
    const f = FILE_ID_RE.test(id) ? q.file.get(id) : null;
    if (!f || f.revoked_at) return 'unknown file';
    files.push({ id: f.id, name: f.name, ext: f.ext, size: f.size, inline: !!f.inline });
  }
  // "@herkes" / "@all" addresses everyone (and wakes every agent).
  const everyone = /(^|\s)@(herkes|all)\b/iu.test(text);
  return { author, project, kind, text, to: kind === 'approval' ? HUMAN : to || (everyone ? 'all' : null), topic, files, replyTo, source: b.source === 'log' ? 'log' : 'chat' };
}

// Pending long-polls are notified by writes, never by a polling interval.
const waiters = new Set();
function waitForMessages(res, rows, seconds) {
  let timer;
  const cleanup = () => { clearTimeout(timer); waiters.delete(check); res.off('close', cleanup); };
  const finish = messages => { cleanup(); if (!res.destroyed) send(res, 200, messages); };
  const check = () => { const messages = rows(); if (messages.length) finish(messages); };
  waiters.add(check);
  res.on('close', cleanup);
  timer = setTimeout(() => finish([]), seconds * 1000);
  check(); // Check after subscribing so a message cannot fall between read and registration.
}

function post(m, tool, announce = true) {
  const authorAgent = q.agent.get(m.author);
  if (authorAgent?.retired) throw new Error(`${m.author} is retired; cannot post messages`);
  ensureAgent(m.author, tool);
  ensureProject(m.project, announce);
  if (m.to && m.to !== 'all') ensureAgent(m.to);
  const { lastInsertRowid } = q.add.run(m.project, m.author, m.kind, m.to, m.topic, m.text,
    m.files?.length ? JSON.stringify(m.files) : null, m.replyTo ?? null, now(), m.source || 'chat');
  const row = withFiles(q.byId.get(lastInsertRowid));
  if (announce) {
    broadcast('message', row);
    broadcast('agents', q.agents.all());
    if (m.kind === 'approval') broadcast('approvals', {});
  }
  for (const check of [...waiters]) check();
  return row;
}

async function upload(req, url) {
  const uploader = String(url.searchParams.get('as') || '');
  const name = String(url.searchParams.get('name') || '').replace(/[\\/\0\r\n]/g, '_').slice(0, 120);
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!NAME_RE.test(uploader)) return 'as=<name> required';
  if (!name || !UPLOAD_TYPES[ext]) return `allowed: ${Object.keys(UPLOAD_TYPES).join(', ')}`;
  const bytes = await readBody(req, MAX_FILE);
  if (!bytes.length) return 'empty file';
  const magic = MAGIC[ext];
  const matches = magic ? magic.every((b, i) => bytes[i] === b) : true;
  if (magic && !matches) return 'file content does not match its extension';
  const id = randomBytes(12).toString('hex');
  writeFileSync(join(FILES, `${id}.${ext}`), bytes, { mode: 0o600 });
  q.addFile.run(id, name, ext, bytes.length, uploader, ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) ? 1 : 0, now());
  return { id, name, ext, size: bytes.length, inline: ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) };
}

function serveFile(res, id) {
  const f = FILE_ID_RE.test(id) ? q.file.get(id) : null;
  if (!f || f.revoked_at) return send(res, 404, { error: 'not found' });
  const body = readFileSync(join(FILES, `${f.id}.${f.ext}`));
  const encoded = encodeURIComponent(f.name);
  return send(res, 200, body, f.inline || f.ext === 'pdf' ? UPLOAD_TYPES[f.ext] : 'application/octet-stream', {
    'Content-Disposition': `${f.inline || f.ext === 'pdf' ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
    'Content-Security-Policy': f.ext === 'pdf' ? "default-src 'none'" : 'sandbox',
    'Cache-Control': 'no-store',
  });
}

// Usage limits per agent. Codex agents are filled automatically from Codex's own session logs.
const usageRows = () => q.usage.all().map(r => ({ ...r, windows: JSON.parse(r.windows) }));
// Limits must come from a machine source: Codex's own logs (server-side) or the raw JSON of the
// Claude desktop app's usage card (get_usage). Hand-typed numbers are not accepted.
const LABELS = { '5-hour limit': '5 saatlik', 'Weekly · all models': 'Haftalık' };
export function validateUsage(b) {
  const agent = String(b.agent || '').trim();
  if (!NAME_RE.test(agent)) return 'agent name required';
  const ag = q.agent.get(agent);
  if (ag?.retired) return 'cannot update usage for retired agent';
  if (ag?.tool === 'Codex') return 'Codex limits are read automatically from its logs';
  if ((ag?.tool || '').toLowerCase() === 'antigravity') return 'Antigravity limits are read automatically from local service';
  const plan = b.raw?.plan;
  if (!plan || plan.status !== 'ok' || !Array.isArray(plan.windows)) return 'send the raw get_usage JSON as "raw" (plan.status must be ok)';
  return toUsage(agent, plan.plan, plan.windows.map(w => ({ label: LABELS[w.label] || w.label, percent_used: w.percentUsed, resets_at: w.resetsAt })), 'claude-app');
}
function toUsage(agent, planName, list, source) {
  if (list.length > 6) return 'max 6 windows';
  const windows = [];
  for (const w of list) {
    const label = String(w.label || '').slice(0, 60);
    const percent = Number(w.percent_used);
    const resets = w.resets_at ? new Date(w.resets_at) : null;
    if (!label || !Number.isFinite(percent) || percent < 0 || percent > 100) return 'each window needs label and percent 0-100';
    if (resets && Number.isNaN(resets.getTime())) return 'resets_at must be a date';
    windows.push({ label, percent_used: Math.round(percent), resets_at: resets ? resets.toISOString() : null });
  }
  return { agent, plan: planName ? String(planName).slice(0, 40) : null, windows, note: null, source };
}
function saveUsage(u) {
  q.setUsage.run(u.agent, u.plan, JSON.stringify(u.windows), u.note, u.source, now());
  broadcast('usage', usageRows());
}

const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions');
function newestFiles(dir, depth = 0, out = []) {
  if (depth > 3 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) newestFiles(p, depth + 1, out);
    else if (name.endsWith('.jsonl')) out.push({ p, m: st.mtimeMs });
  }
  return out;
}
function findKey(node, key) {
  if (!node || typeof node !== 'object') return null;
  if (key in node) return node[key];
  for (const v of Object.values(node)) { const hit = findKey(v, key); if (hit) return hit; }
  return null;
}
function scanCodex() {
  try {
    const agents = q.byTool.all('Codex').map(a => a.name);
    if (!agents.length) return;
    const files = newestFiles(CODEX_SESSIONS).sort((a, b) => b.m - a.m).slice(0, 5);
    for (const { p } of files) {
      const lines = readFileSync(p, 'utf8').trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        const r = findKey(JSON.parse(lines[i]), 'rate_limits');
        if (!r?.primary) continue;
        const label = (w) => w?.window_minutes >= 10080 ? 'Haftalık' : `${Math.round((w?.window_minutes || 300) / 60)} saatlik`;
        const win = (w) => w && { label: label(w), percent_used: w.used_percent, resets_at: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null };
        for (const agent of agents) {
          const u = toUsage(agent, null, [win(r.primary), win(r.secondary)].filter(Boolean), 'codex-log');
          if (typeof u !== 'string') saveUsage(u);
        }
        return;
      }
    }
  } catch { /* a malformed or busy log must never stop the hub */ }
}

function parseAntigravityQuota(data) {
  const groups = data?.response?.groups;
  if (!Array.isArray(groups) || !groups.length) return null;
  const windows = [];
  for (const g of groups) {
    const name = String(g.displayName || '');
    let prefix = name;
    if (/gemini/i.test(name)) prefix = 'Gemini';
    else if (/claude|gpt|3p/i.test(name)) prefix = 'Claude/GPT';

    const buckets = Array.isArray(g.buckets) ? g.buckets : [];
    const sortedBuckets = [...buckets].sort((a, b) => {
      const isA5h = a.window === '5h' || String(a.bucketId).includes('5h');
      const isB5h = b.window === '5h' || String(b.bucketId).includes('5h');
      return isA5h === isB5h ? 0 : isA5h ? -1 : 1;
    });

    for (const b of sortedBuckets) {
      const is5h = b.window === '5h' || String(b.bucketId).includes('5h');
      const isWeekly = b.window === 'weekly' || String(b.bucketId).includes('weekly');
      const winLabel = is5h ? '5 saatlik' : isWeekly ? 'Haftalık' : (b.displayName || b.window || 'limit');
      const fraction = typeof b.remainingFraction === 'number' ? b.remainingFraction : null;
      if (fraction === null) continue;
      const percent_used = Math.max(0, Math.min(100, Math.round((1 - fraction) * 100)));
      const resets = b.resetTime ? new Date(b.resetTime) : null;
      const label = `${prefix} ${winLabel}`;
      const existing = windows.find(w => w.label === label);
      if (existing) {
        if (percent_used > existing.percent_used) {
          existing.percent_used = percent_used;
          existing.resets_at = resets && !Number.isNaN(resets.getTime()) ? resets.toISOString() : existing.resets_at;
        }
      } else {
        windows.push({
          label,
          percent_used,
          resets_at: resets && !Number.isNaN(resets.getTime()) ? resets.toISOString() : null,
        });
      }
    }
  }
  return windows.length ? windows : null;
}

function getAntigravityServerInfo() {
  try {
    const stdout = execFileSync('ps', ['-ax', '-o', 'pid,command'], { encoding: 'utf8', timeout: 3000 });
    let pid = null;
    let token = null;
    for (const line of stdout.split('\n')) {
      if (!line.includes('language_server') || !line.includes('--csrf_token')) continue;
      const pidMatch = line.trim().match(/^(\d+)/);
      const tokenMatch = line.match(/--csrf_token\s+([a-zA-Z0-9-]+)/);
      if (pidMatch && tokenMatch) {
        pid = pidMatch[1];
        token = tokenMatch[1];
        break;
      }
    }
    if (!pid || !token) return null;
    const lsof = execFileSync('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pid], { encoding: 'utf8', timeout: 3000 });
    const ports = [];
    for (const m of lsof.matchAll(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/g)) {
      ports.push(Number(m[1]));
    }
    if (!ports.length) return null;
    return { pid, token, ports };
  } catch {
    return null;
  }
}

function requestQuotaFromPort(port, token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      method: 'POST',
      headers: {
        'x-codeium-csrf-token': token,
        'Connect-Protocol-Version': '1',
        'Content-Type': 'application/json',
      },
      rejectUnauthorized: false,
      timeout: 2000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end('{}');
  });
}

async function scanAntigravity(finder = getAntigravityServerInfo) {
  try {
    const agents = q.agents.all()
      .filter(a => (a.tool || '').toLowerCase() === 'antigravity')
      .map(a => a.name);
    if (!agents.length) return;

    const info = finder ? finder() : null;
    let windows = null;
    if (info) {
      for (const port of info.ports) {
        const data = await requestQuotaFromPort(port, info.token);
        if (data) {
          windows = parseAntigravityQuota(data);
          if (windows) break;
        }
      }
    }

    if (windows) {
      for (const agent of agents) {
        const u = toUsage(agent, 'Antigravity Ultra', windows, 'antigravity-local');
        if (typeof u !== 'string') saveUsage(u);
      }
    } else {
      for (const agent of agents) {
        q.setUsage.run(agent, 'Antigravity Ultra', '[]', null, 'okunamadı', now());
      }
      broadcast('usage', usageRows());
    }
  } catch {
    /* a malformed or busy language server must never stop the hub */
  }
}

const page = () => readFileSync(join(HERE, 'public', 'index.html'), 'utf8');

const server = createServer(async (req, res) => {
  try {
    // DNS-rebinding guard: only our own host names reach the app.
    if (!ALLOWED_HOSTS.has(req.headers.host || '')) return send(res, 421, { error: 'host not allowed' });
    const url = new URL(req.url, `http://${req.headers.host}`);

    const localBrowser = isLocalBrowser(req, PORT);
    const pageHeaders = {
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    };
    const sessionCookie = `hub=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`;
    if (req.method === 'GET' && url.pathname === '/') {
      const allowed = localBrowser || tokenOk(req);
      return send(res, 200, allowed ? page() : pagePairing(), 'text/html; charset=utf-8', {
        ...pageHeaders,
        ...(localBrowser ? { 'Set-Cookie': sessionCookie } : {}),
      });
    }
    if (req.method === 'GET' && url.pathname === '/approvals.js') return send(res, 200, readFileSync(join(HERE, 'public', 'approvals.js'), 'utf8'), 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/excalibur.jpg') return send(res, 200, readFileSync(join(HERE, 'public', 'excalibur.jpg')), 'image/jpeg', { 'Cache-Control': 'public, max-age=86400' });
    if (req.method === 'POST' && url.pathname === '/pair') {
      if (!LAN_MODE) return send(res, 403, { error: 'LAN pairing is disabled' });
      if (req.headers.origin !== url.origin) return send(res, 403, { error: 'same-origin pairing required' });
      if (Number(req.headers['content-length']) > 256) return send(res, 413, { error: 'pairing body too large' });
      let code;
      try {
        const body = (await readBody(req, 256)).toString('utf8');
        code = (req.headers['content-type'] || '').startsWith('application/json')
          ? JSON.parse(body).code : new URLSearchParams(body).get('code');
      } catch { return send(res, 400, { error: 'invalid pairing request' }); }
      const result = pairing.verify(req.socket.remoteAddress || '', code);
      if (result !== 200) return send(res, result, { error: result === 429 ? 'too many attempts; wait one minute' : 'invalid or expired pairing code' });
      return send(res, 200, { ok: true }, 'application/json; charset=utf-8', { 'Set-Cookie': sessionCookie });
    }
    const isFile = req.method === 'GET' && url.pathname.startsWith('/files/');
    if (!url.pathname.startsWith('/api/') && !isFile) return send(res, 404, { error: 'not found' });
    if (!tokenOk(req)) return send(res, 401, { error: 'token required' });
    if (isFile) return serveFile(res, url.pathname.slice(7));

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/approvals') return send(res, 200, approvals.pending().map(withFiles));
    if (req.method === 'POST' && url.pathname === '/api/approvals/resolve') return await resolveApproval(req, res, url.origin);
    if (req.method === 'GET' && url.pathname === '/api/messages/context') {
      const id = Number(url.searchParams.get('id'));
      const row = Number.isSafeInteger(id) && id > 0 ? q.byId.get(id) : null;
      if (!row) return send(res, 404, { error: 'message not found' });
      const before = db.prepare('SELECT * FROM messages WHERE project = ? AND id <= ? ORDER BY id DESC LIMIT 26').all(row.project, id).reverse();
      const after = db.prepare('SELECT * FROM messages WHERE project = ? AND id > ? ORDER BY id ASC LIMIT 25').all(row.project, id);
      return send(res, 200, { project: row.project, messages: [...before, ...after].map(withFiles) });
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') return send(res, 200, q.projects.all());
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const cfg = readConfig();
      return send(res, 200, {
        port: PORT,
        configuredPort: cfg.port || 7788,
        lan: LAN_MODE,
        configuredLan: Boolean(cfg.lan),
        operator: HUMAN,
        configuredOperator: cfg.operator || HUMAN,
        localIps,
        pairingCode: LAN_MODE && localBrowser ? pairing.current().code : null,
        pairingExpiresAt: LAN_MODE && localBrowser ? pairing.current().expiresAt : null,
        listenHost: LISTEN_HOST,
        dataDir: DATA,
        version: HUB_VERSION,
        maxText: MAX_TEXT,
        agentSchedule: agentSchedule(cfg),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readJson(req);
      const actor = String(body.as || '').trim();
      const coord = q.coordinator.get()?.name;
      const isAuth = actor === HUMAN || (coord && actor === coord);
      if (!isAuth) return send(res, 403, { error: `only ${HUMAN} or the coordinator can update configuration` });

      const updates = {};
      if (body.port !== undefined) {
        const p = Number(body.port);
        if (!Number.isInteger(p) || p < 1024 || p > 65535) {
          return send(res, 422, { error: 'port must be an integer between 1024 and 65535' });
        }
        updates.port = p;
      }
      if (body.lan !== undefined) {
        updates.lan = Boolean(body.lan);
      }
      if (body.operator !== undefined) {
        const op = String(body.operator).trim();
        if (op && NAME_RE.test(op)) {
          updates.operator = op;
        }
      }
      const sched = validateSchedule(body);
      if (typeof sched === 'string') return send(res, 422, { error: sched });
      Object.assign(updates, sched);
      const saved = writeConfig(updates);
      // Schedule changes apply at once (agents read them); only port/LAN/operator need a restart.
      if (sched.scheduleUpdatedAt) broadcast('config', { agentSchedule: agentSchedule(saved) });
      const restartRequired = (updates.port !== undefined && updates.port !== PORT) || (updates.lan !== undefined && updates.lan !== LAN_MODE) || (updates.operator !== undefined && updates.operator !== HUMAN);
      return send(res, 200, {
        ok: true,
        config: saved,
        restartRequired,
        agentSchedule: agentSchedule(saved),
        command: 'pkill -f "node.*server.mjs" && node ~/agent-hub/server.mjs'
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/rules') {
      const proj = url.searchParams.get('project');
      return send(res, 200, proj ? q.rulesByProject.all(proj) : q.rules.all());
    }
    if (req.method === 'POST' && url.pathname === '/api/rules') {
      const body = await readJson(req);
      const actor = String(body.as || '').trim();
      const text = String(body.text || '').trim();
      const category = String(body.category || 'Nasıl çalışırız').trim();
      const project = body.project ? String(body.project).trim().toLowerCase() : null;
      if (!text) return send(res, 422, { error: 'rule text required' });
      const coord = q.coordinator.get()?.name;
      const isAuth = actor === HUMAN || (coord && actor === coord);
      if (!isAuth) return send(res, 403, { error: `only ${HUMAN} or the coordinator can add rules` });
      const currentNow = now();
      const order = Number(body.sort_order) || (q.maxRuleOrder.get()?.m || 0) + 1;
      const r = q.addRule.run(text, category, actor, currentNow, currentNow, order, project);
      const row = q.ruleById.get(Number(r.lastInsertRowid));
      broadcast('rules', q.rules.all());
      return send(res, 201, row);
    }
    if (req.method === 'PUT' && url.pathname === '/api/rules') {
      const body = await readJson(req);
      const actor = String(body.as || '').trim();
      const id = Number(body.id);
      const text = String(body.text || '').trim();
      const category = String(body.category || '').trim();
      const project = body.project !== undefined ? (body.project ? String(body.project).trim().toLowerCase() : null) : undefined;
      if (!id || !text) return send(res, 422, { error: 'id and rule text required' });
      const existing = q.ruleById.get(id);
      if (!existing) return send(res, 404, { error: 'rule not found' });
      const coord = q.coordinator.get()?.name;
      const isAuth = actor === HUMAN || (coord && actor === coord);
      if (!isAuth) return send(res, 403, { error: `only ${HUMAN} or the coordinator can edit rules` });
      const currentNow = now();
      const order = Number(body.sort_order ?? existing.sort_order);
      const projVal = project !== undefined ? project : existing.project;
      q.updateRule.run(text, category || existing.category, order, currentNow, projVal, id);
      const row = q.ruleById.get(id);
      broadcast('rules', q.rules.all());
      return send(res, 200, row);
    }
    if (req.method === 'DELETE' && url.pathname === '/api/rules') {
      const body = await readJson(req);
      const actor = String(body.as || '').trim();
      const id = Number(body.id);
      if (!id) return send(res, 422, { error: 'rule id required' });
      const existing = q.ruleById.get(id);
      if (!existing) return send(res, 404, { error: 'rule not found' });
      const coord = q.coordinator.get()?.name;
      const isAuth = actor === HUMAN || (coord && actor === coord);
      if (!isAuth) return send(res, 403, { error: `only ${HUMAN} or the coordinator can delete rules` });
      q.deleteRule.run(id);
      broadcast('rules', q.rules.all());
      return send(res, 200, { ok: true, deleted: id });
    }
    if (req.method === 'POST' && url.pathname === '/api/projects/state') {
      // Pin, archive or delete (hide) a chat; messages are kept.
      const b = await readJson(req);
      const slug = String(b.slug || '');
      const row = PROJECT_RE.test(slug) ? q.project.get(slug) : null;
      if (!row) return send(res, 404, { error: 'unknown project' });
      const flag = (v) => (v === undefined ? null : (v ? 1 : 0));
      q.setProjectState.run(flag(b.pinned), flag(b.archived), b.deleted === undefined ? row.deleted_at : (b.deleted ? now() : null), slug);
      broadcast('projects', q.projects.all());
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/agents') return send(res, 200, url.searchParams.get('all') === '1' ? q.allAgents.all() : q.agents.all());
    if (req.method === 'GET' && url.pathname === '/api/usage') return send(res, 200, usageRows());
    if (req.method === 'POST' && url.pathname === '/api/usage') {
      const u = validateUsage(await readJson(req));
      if (typeof u === 'string') return send(res, 422, { error: u });
      saveUsage(u);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/files') {
      // Raw body, not a form: cross-site pages cannot send it without a preflight.
      if ((req.headers['content-type'] || '') !== 'application/octet-stream') return send(res, 415, { error: 'send application/octet-stream' });
      const f = await upload(req, url);
      return typeof f === 'string' ? send(res, 422, { error: f }) : send(res, 201, f);
    }
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const project = String(url.searchParams.get('project') || '');
      if (!PROJECT_RE.test(project)) return send(res, 422, { error: 'invalid project' });
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const as = url.searchParams.get('as');
      if (as && NAME_RE.test(as) && q.agent.get(as)) { ensureAgent(as); broadcast('agents', q.agents.all()); }
      return send(res, 200, q.list.all(project, since, limit).reverse().map(withFiles));
    }
    if (req.method === 'GET' && url.pathname === '/api/wait') {
      const as = String(url.searchParams.get('as') || '');
      const project = url.searchParams.get('project');
      const since = Number(url.searchParams.get('since') || 0);
      const seconds = Number(url.searchParams.get('timeout') ?? 300);
      if (!NAME_RE.test(as) || (project !== null && !PROJECT_RE.test(project))
        || !Number.isSafeInteger(since) || since < 0 || !Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
        return send(res, 422, { error: 'valid as, project, since and timeout (1–300 seconds) required' });
      }
      if (q.agent.get(as)?.retired) return send(res, 403, { error: 'retired agent cannot wait' });
      ensureAgent(as);
      waitForMessages(res, () => q.waitInbox.all(since, as, project, project, as, as, as, HUMAN, as).map(withFiles), seconds);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/inbox') {
      const as = String(url.searchParams.get('as') || '');
      if (!NAME_RE.test(as)) return send(res, 422, { error: 'as=<agent name> required' });
      ensureAgent(as);
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      if (url.searchParams.get('personal') === '1') return send(res, 200, q.personalInbox.all(since, as, as, as, as, limit).reverse().map(withFiles));
      return send(res, 200, q.inbox.all(since, as, as, as, as, limit).map(withFiles));
    }
    if (req.method === 'POST' && url.pathname === '/api/messages/retract') {
      const body = await readJson(req);
      const actor = String(body.as || '');
      const id = Number(body.id);
      if (!NAME_RE.test(actor) || !Number.isSafeInteger(id) || id < 1) return send(res, 422, { error: 'valid as and message id required' });
      // The UI uses the HttpOnly cookie and a same-origin browser request; CLI may not act as the operator.
      if (actor === HUMAN && (req.headers['x-hub-token'] || req.headers.origin !== url.origin || !req.headers.cookie)) {
        return send(res, 403, { error: 'operator retraction requires the Hub browser' });
      }
      const row = q.byId.get(id);
      if (!row) return send(res, 404, { error: 'unknown message' });
      if (row.author !== actor || !canRetractSource(row)) return send(res, 403, { error: 'only your own chat messages can be retracted; log records are protected' });
      if (!row.retracted_at) {
        const at = now();
        db.exec('BEGIN IMMEDIATE');
        try {
          q.retract.run(at, actor, id);
          q.clearReactions.run(id);
          for (const f of row.files ? JSON.parse(row.files) : []) q.revokeFile.run(at, f.id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        broadcast('retract', withFiles(q.byId.get(id)));
        if (row.kind === 'approval') broadcast('approvals', {});
      }
      return send(res, 200, withFiles(q.byId.get(id)));
    }
    if (req.method === 'POST' && url.pathname === '/api/messages/react') {
      const body = await readJson(req);
      const actor = String(body.as || '').trim();
      const id = Number(body.id);
      const emoji = String(body.emoji || '').trim();
      if (!NAME_RE.test(actor) || !Number.isSafeInteger(id) || id < 1 || !ALLOWED_REACTIONS.has(emoji)) {
        return send(res, 422, { error: 'valid as, message id, and supported reaction emoji required' });
      }
      if (actor === HUMAN && (req.headers['x-hub-token'] || req.headers.origin !== url.origin || !req.headers.cookie)) {
        return send(res, 403, { error: 'operator reaction requires the Hub browser' });
      }
      if (q.agent.get(actor)?.retired) {
        return send(res, 403, { error: `${actor} is retired; cannot react to messages` });
      }
      const row = q.byId.get(id);
      if (!row) return send(res, 404, { error: 'unknown message' });
      if (row.retracted_at) return send(res, 409, { error: 'cannot react to a retracted message' });
      ensureAgent(actor);
      if (q.hasReaction.get(id, actor, emoji)) {
        q.removeReaction.run(id, actor, emoji);
      } else {
        q.addReaction.run(id, actor, emoji, now());
      }
      const reactions = reactionsFor(id);
      broadcast('reaction', { id, project: row.project, reactions });
      return send(res, 200, { id, reactions });
    }
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      const body = await readJson(req);
      const m = validateMessage(body);
      if (typeof m === 'string') return send(res, 422, { error: m });
      const authorAgent = q.agent.get(m.author);
      if (authorAgent?.retired) return send(res, 403, { error: `${m.author} is retired; cannot post messages` });
      const claim = m.kind === 'claim' && m.topic
        ? q.openClaim.get(m.project, m.topic, m.author, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()) : null;
      const row = post(m, body.tool ? String(body.tool).slice(0, 40) : null);
      if (claim) row.claim_warning = { id: claim.id, author: claim.author, topic: claim.topic, created_at: claim.created_at };
      return send(res, 201, row);
    }
    if (req.method === 'POST' && url.pathname === '/api/agents/color') {
      const body = await readJson(req);
      const name = String(body.name || '');
      const color = String(body.color || '');
      if (!NAME_RE.test(name) || !/^#[0-9a-fA-F]{6}$/.test(color)) return send(res, 422, { error: 'name and #rrggbb color required' });
      ensureAgent(name);
      q.setColor.run(color, name);
      broadcast('agents', q.agents.all());
      return send(res, 200, q.agent.get(name));
    }
    if (req.method === 'POST' && url.pathname === '/api/agents/profile') {
      // avatar: an emoji (up to 8 chars) or the id of an uploaded image. role: 'coordinator' moves the star.
      const body = await readJson(req);
      const name = String(body.name || '');
      if (!NAME_RE.test(name) || name === HUMAN && body.role) return send(res, 422, { error: 'agent name required' });
      ensureAgent(name);
      if (body.avatar !== undefined) {
        const a = String(body.avatar || '').trim();
        const isImage = FILE_ID_RE.test(a) && q.file.get(a)?.inline;
        const isEmoji = a && [...a].length <= 8 && !/[<>"'&\s]/.test(a) && !FILE_ID_RE.test(a);
        if (a && !isImage && !isEmoji) return send(res, 422, { error: 'avatar: an emoji or an uploaded image id' });
        q.setAvatar.run(a ? (isImage ? `file:${a}` : `emoji:${a}`) : null, name);
      }
      if (body.role !== undefined) {
        if (body.role === 'coordinator') { q.clearCoordinator.run(); q.setRole.run('coordinator', name); }
        else if (body.role === null) q.setRole.run(null, name);
        else return send(res, 422, { error: "role: 'coordinator' or null" });
      }
      broadcast('agents', q.agents.all());
      return send(res, 200, q.agent.get(name));
    }
    if (req.method === 'POST' && url.pathname === '/api/agents/retire') {
      const body = await readJson(req);
      const actor = String(body.as || '').trim();
      const name = String(body.name || '').trim();
      const retired = body.retired ? 1 : 0;
      if (!NAME_RE.test(actor) || !NAME_RE.test(name)) return send(res, 422, { error: 'valid as and agent name required' });
      if (name === HUMAN) return send(res, 422, { error: 'operator cannot be retired' });
      const coord = q.coordinator.get()?.name;
      const isAuth = actor === HUMAN || (coord && actor === coord);
      if (!isAuth) return send(res, 403, { error: `only ${HUMAN} or the coordinator can retire/unretire agents` });
      const target = q.agent.get(name);
      if (!target) return send(res, 404, { error: `unknown agent: ${name}` });
      if (target.role === 'coordinator' && retired) return send(res, 422, { error: 'cannot retire the active coordinator' });
      q.setRetired.run(retired, name);
      broadcast('agents', q.agents.all());
      broadcast('usage', usageRows());
      return send(res, 200, q.agent.get(name));
    }
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    return send(res, 400, { error: String(error.message || error).slice(0, 200) });
  }
});

if (process.env.HUB_NO_LISTEN !== '1') {
  scanCodex();
  scanAntigravity().catch(() => {});
  setInterval(scanCodex, 120000).unref();
  setInterval(() => { scanAntigravity().catch(() => {}); }, 120000).unref();
  server.listen(PORT, LISTEN_HOST, () => {
    console.log(`Agent Hub on http://${LISTEN_HOST === '0.0.0.0' ? '127.0.0.1' : LISTEN_HOST}:${PORT}  (data: ${DATA})`);
    if (LAN_MODE && localIps.length) {
      console.log(`LAN erişimi açık: ${localIps.map(ip => `http://${ip}:${PORT}`).join(', ')}`);
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${PORT} kullanımda!`);
      console.error(`Olası çözümler:`);
      console.error(`  1. Bu portu kullanan süreci kapatın: lsof -ti:${PORT} | xargs kill`);
      console.error(`  2. Farklı bir portla başlatın: HUB_PORT=7790 node server.mjs`);
      console.error(`  3. Veya ~/.agent-hub/config.json içinde "port": 7790 olarak ayarlayın.\n`);
      process.exit(1);
    }
    throw err;
  });
}
export { server, post, scanAntigravity, parseAntigravityQuota, ensureAgent, readConfig, writeConfig, getLocalIps, ALLOWED_HOSTS, PORT, LAN_MODE, LISTEN_HOST };
