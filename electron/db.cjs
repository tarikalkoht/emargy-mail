const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { classifyTrust, trustedAuthServers } = require('./core.cjs');
const { CATEGORIES, categorize } = require('./categorize.cjs');

const SCHEMA_VERSION = 2;
const AUDIT_LIMIT = 1000;
const DEFAULT_BODY_DAYS = 90;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_at INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  role TEXT NOT NULL,
  uid_validity TEXT,
  last_uid INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, path)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid INTEGER NOT NULL,
  date INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  important INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  header BLOB NOT NULL,
  raw BLOB,
  UNIQUE (folder_id, uid)
);
CREATE INDEX IF NOT EXISTS messages_date ON messages (date DESC);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, details BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS trusted_image_senders (fingerprint TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS signatures (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS sender_rules (fingerprint TEXT PRIMARY KEY, category TEXT NOT NULL DEFAULT '', verdict TEXT NOT NULL DEFAULT '');
-- Follow-up reminders (no reply after N days) and snoozed conversations.
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_key TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_gone (account_id TEXT NOT NULL, remote_id TEXT NOT NULL, PRIMARY KEY (account_id, remote_id));
`;

/**
 * Fold text so a search finds what the reader meant, not only the exact letters typed:
 * case, Arabic diacritics and tatweel are ignored, alef/hamza forms, taa marbuta and
 * alef maqsura match their plain letters, and Arabic-Indic digits match 0-9.
 */
function normalizeSearch(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u0640]/g, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0649/g, '\u064a')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064a')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\s+/g, ' ')
    .trim();
}

/** A subject without its "Re:" / "Fwd:" / "رد:" prefixes, folded for comparison. */
function replySubject(subject = '') {
  let text = String(subject || '');
  for (let i = 0; i < 5; i += 1) {
    const next = text.replace(/^\s*(re|fw|fwd|aw|wg|sv|vs|رد|ر|إعادة توجيه|اعادة توجيه|توجيه)\s*(\[\d+\])?\s*[:：]\s*/i, '');
    if (next === text) break;
    text = next;
  }
  return normalizeSearch(text);
}

/** Every word of the query must appear somewhere (in any order). */
function searchMatcher(query) {
  const words = normalizeSearch(query).split(' ').filter(Boolean);
  return words.length ? (haystack) => words.every((word) => haystack.includes(word)) : null;
}

function searchText(header) {
  return normalizeSearch([header.subject, header.from, header.to, header.cc, header.preview].filter(Boolean).join(' '));
}

/** Split an address list on commas/semicolons that are outside quotes and <…>. */
function parseAddressList(value = '') {
  const parts = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const char of String(value)) {
    if (char === '"') quoted = !quoted;
    else if (char === '<' && !quoted) angle = true;
    else if (char === '>' && !quoted) angle = false;
    if ((char === ',' || char === ';') && !quoted && !angle) { parts.push(current); current = ''; } else current += char;
  }
  parts.push(current);
  const result = [];
  for (const part of parts) {
    const text = part.trim();
    const bracket = text.match(/^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
    const bare = !bracket && text.match(/[^\s<>"]+@[^\s<>"]+/);
    if (!bracket && !bare) continue;
    const address = (bracket ? bracket[2] : bare[0]).toLowerCase();
    const name = bracket ? bracket[1].trim().replace(/^"|"$/g, '').trim() : '';
    result.push({ name: name && name.toLowerCase() !== address ? name : '', address });
  }
  return result;
}

/** Important = the assistant said so, or important words in a message that is not spam or suspicious. */
function isImportantMessage(m) {
  if (['spam', 'suspicious'].includes(m.trust)) return false;
  return Boolean(m.aiImportant || m.important);
}

function threadRoot(header, id) {
  const references = String(header.references || '').match(/<[^>]+>/g) || [];
  return references[0] || header.inReplyTo || header.messageId || id;
}

class Database {
  constructor({ file, vault }) {
    this.vault = vault;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
    this.db.exec(SCHEMA);
    this.upgradeSchema();
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.loadHeaderCache();
    this.loadReminderCache();
  }

  upgradeSchema() {
    const columns = (table) => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!columns('folders').has('name')) this.db.exec('ALTER TABLE folders ADD COLUMN name TEXT');
    if (!columns('messages').has('thread_key')) this.db.exec('ALTER TABLE messages ADD COLUMN thread_key TEXT');
    if (!columns('folders').has('server_total')) this.db.exec('ALTER TABLE folders ADD COLUMN server_total INTEGER NOT NULL DEFAULT 0');
    if (!columns('folders').has('floor_uid')) this.db.exec('ALTER TABLE folders ADD COLUMN floor_uid INTEGER NOT NULL DEFAULT 0');
    if (!columns('folders').has('older_done')) this.db.exec('ALTER TABLE folders ADD COLUMN older_done INTEGER NOT NULL DEFAULT 0');
    if (!columns('accounts').has('sort_order')) this.db.exec('ALTER TABLE accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    if (!columns('projects').has('sort_order')) this.db.exec('ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    // Spam / trust verdict from the server's own filter and the sender authentication results.
    if (!columns('messages').has('trust')) this.db.exec("ALTER TABLE messages ADD COLUMN trust TEXT NOT NULL DEFAULT ''");
    if (!columns('messages').has('ai_important')) this.db.exec('ALTER TABLE messages ADD COLUMN ai_important INTEGER NOT NULL DEFAULT 0');
    if (!columns('messages').has('ai_checked')) this.db.exec('ALTER TABLE messages ADD COLUMN ai_checked INTEGER NOT NULL DEFAULT 0');
    if (!columns('messages').has('ai_note')) this.db.exec('ALTER TABLE messages ADD COLUMN ai_note BLOB');
    // Inbox tab (primary, promotions, social, updates); locked = Gmail chose it.
    if (!columns('messages').has('category')) this.db.exec("ALTER TABLE messages ADD COLUMN category TEXT NOT NULL DEFAULT ''");
    if (!columns('messages').has('category_locked')) this.db.exec('ALTER TABLE messages ADD COLUMN category_locked INTEGER NOT NULL DEFAULT 0');
    // Accounts without IMAP (Resend) keep the provider's own id of each message.
    if (!columns('messages').has('remote_id')) this.db.exec('ALTER TABLE messages ADD COLUMN remote_id TEXT');
    // What the provider last reported for mail you sent (Resend: delivered, bounced, suppressed…).
    if (!columns('messages').has('delivery')) this.db.exec("ALTER TABLE messages ADD COLUMN delivery TEXT NOT NULL DEFAULT ''");
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_key)');
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_remote ON messages (account_id, remote_id)');
  }

  close() {
    this.db.close();
  }

  transaction(work) {
    this.db.exec('BEGIN');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  id() {
    return crypto.randomUUID();
  }

  // Settings -----------------------------------------------------------------
  getSetting(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  /** A setting whose value is encrypted at rest (e.g. a personal picture). */
  getSecret(key) {
    const stored = this.getSetting(`secret:${key}`);
    return stored ? this.vault.decryptJson(Buffer.from(stored, 'base64')).value : null;
  }

  setSecret(key, value) {
    if (value === null || value === undefined) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(`secret:${key}`);
      return;
    }
    this.setSetting(`secret:${key}`, Buffer.from(this.vault.encryptJson({ value })).toString('base64'));
  }

  // Projects -----------------------------------------------------------------
  listProjects() {
    return this.db.prepare('SELECT id, created_at, data FROM projects ORDER BY sort_order, created_at').all()
      .map((row) => ({ id: row.id, createdAt: row.created_at, ...this.vault.decryptJson(row.data) }));
  }

  createProject({ name, color }, id = this.id(), createdAt = Date.now()) {
    const next = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM projects').get().n;
    this.db.prepare('INSERT INTO projects (id, created_at, data, sort_order) VALUES (?, ?, ?, ?)')
      .run(id, createdAt, this.vault.encryptJson({ name, color }), next);
    return id;
  }

  /** Save the order the reader arranged; ids not listed keep their place after the listed ones. */
  reorderProjects(ids) {
    const known = new Set(this.db.prepare('SELECT id FROM projects').all().map((r) => r.id));
    const ordered = [...new Set(ids.filter((id) => known.has(id)))];
    const rest = this.listProjects().map((p) => p.id).filter((id) => !ordered.includes(id));
    const update = this.db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
    this.transaction(() => [...ordered, ...rest].forEach((id, index) => update.run(index + 1, id)));
  }

  deleteProject(id) {
    const used = this.db.prepare('SELECT 1 FROM accounts WHERE project_id = ? LIMIT 1').get(id);
    if (used) throw new Error('Delete the project accounts first.');
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  // Accounts -----------------------------------------------------------------
  listAccounts({ withSecrets = false } = {}) {
    return this.db.prepare('SELECT id, project_id, created_at, data FROM accounts ORDER BY sort_order, created_at').all()
      .map((row) => this.decodeAccount(row, withSecrets));
  }

  getAccount(id, { withSecrets = false } = {}) {
    const row = this.db.prepare('SELECT id, project_id, created_at, data FROM accounts WHERE id = ?').get(id);
    if (!row) throw new Error('Account not found.');
    return this.decodeAccount(row, withSecrets);
  }

  decodeAccount(row, withSecrets) {
    const data = this.vault.decryptJson(row.data);
    const account = { id: row.id, projectId: row.project_id, createdAt: row.created_at, ...data };
    if (!withSecrets) {
      delete account.password;
      delete account.oauth;
      delete account.apiKey;
    }
    return account;
  }

  createAccount(account, id = this.id(), createdAt = Date.now()) {
    const { projectId, ...data } = account;
    const next = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM accounts').get().n;
    this.db.prepare('INSERT INTO accounts (id, project_id, created_at, data, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(id, projectId, createdAt, this.vault.encryptJson(data), next);
    return id;
  }

  /** Save the order the reader arranged; ids not listed keep their place after the listed ones. */
  reorderAccounts(ids) {
    const known = new Set(this.db.prepare('SELECT id FROM accounts').all().map((r) => r.id));
    const ordered = [...new Set(ids.filter((id) => known.has(id)))];
    const rest = this.listAccounts().map((a) => a.id).filter((id) => !ordered.includes(id));
    const update = this.db.prepare('UPDATE accounts SET sort_order = ? WHERE id = ?');
    this.transaction(() => [...ordered, ...rest].forEach((id, index) => update.run(index + 1, id)));
  }

  updateAccount(id, changes) {
    const current = this.getAccount(id, { withSecrets: true });
    const { id: _id, projectId, createdAt, ...data } = { ...current, ...changes };
    this.db.prepare('UPDATE accounts SET project_id = ?, data = ? WHERE id = ?').run(projectId, this.vault.encryptJson(data), id);
  }

  deleteAccount(id) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM folders WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM drafts WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM outbox WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM reminders WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    });
    this.loadReminderCache();
    for (const [key, header] of this.headers) if (header.accountId === id) this.headers.delete(key);
    this.sortHeaders();
  }

  // Folders ------------------------------------------------------------------
  upsertFolder(accountId, folderPath, role, name = folderPath) {
    this.db.prepare(`INSERT INTO folders (account_id, path, role, name) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, path) DO UPDATE SET role = excluded.role, name = excluded.name`).run(accountId, folderPath, role, name);
    return this.db.prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?').get(accountId, folderPath);
  }

  /** Remove folders that disappeared from the server (and their cached messages). */
  pruneFolders(accountId, keepPaths) {
    for (const folder of this.listFolders(accountId)) {
      if (!keepPaths.has(folder.path)) {
        this.resetFolder(folder.id);
        this.db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
      }
    }
  }

  listFolders(accountId) {
    return this.db.prepare('SELECT * FROM folders WHERE account_id = ? ORDER BY id').all(accountId);
  }

  listAllFolders() {
    const unread = {};
    const totals = {};
    for (const message of this.sorted) {
      totals[message.folderId] = (totals[message.folderId] || 0) + 1;
      if (!message.read) unread[message.folderId] = (unread[message.folderId] || 0) + 1;
    }
    return this.db.prepare('SELECT id, account_id, path, role, name, server_total, older_done FROM folders ORDER BY account_id, id').all()
      .map((f) => ({
        id: f.id, accountId: f.account_id, path: f.path, role: f.role, name: f.name || f.path, unread: unread[f.id] || 0, total: totals[f.id] || 0,
        serverTotal: f.server_total, olderDone: Boolean(f.older_done) || (f.server_total > 0 && (totals[f.id] || 0) >= f.server_total),
      }));
  }

  setFolderServerTotal(id, total) {
    this.db.prepare('UPDATE folders SET server_total = ? WHERE id = ?').run(Number(total) || 0, id);
  }

  setFolderFloor(id, uid) {
    this.db.prepare('UPDATE folders SET floor_uid = ? WHERE id = ?').run(Number(uid) || 0, id);
  }

  setFolderOlderDone(id, done) {
    this.db.prepare('UPDATE folders SET older_done = ? WHERE id = ?').run(done ? 1 : 0, id);
  }

  oldestUid(folderId) {
    return this.db.prepare('SELECT MIN(uid) AS uid FROM messages WHERE folder_id = ?').get(folderId)?.uid || null;
  }

  localUids(folderId) {
    return this.db.prepare('SELECT uid FROM messages WHERE folder_id = ?').all(folderId).map((r) => r.uid);
  }

  /** Server search hits for a query, so messages that matched in their body show up in the results. */
  rememberSearch(query, ids) {
    const key = String(query || '').trim().toLowerCase();
    if (!key) return;
    this.searchHits = this.searchHits || new Map();
    this.searchHits.delete(key);
    this.searchHits.set(key, new Set(ids));
    while (this.searchHits.size > 20) this.searchHits.delete(this.searchHits.keys().next().value);
  }

  getFolder(id) {
    return this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  }

  setFolderState(id, { uidValidity, lastUid }) {
    this.db.prepare('UPDATE folders SET uid_validity = ?, last_uid = ? WHERE id = ?').run(uidValidity, lastUid, id);
  }

  resetFolder(id) {
    this.db.prepare('DELETE FROM messages WHERE folder_id = ?').run(id);
    this.db.prepare('UPDATE folders SET uid_validity = NULL, last_uid = 0, older_done = 0, floor_uid = 0 WHERE id = ?').run(id);
    for (const [key, header] of this.headers) if (header.folderId === id) this.headers.delete(key);
    this.sortHeaders();
  }

  // Messages -----------------------------------------------------------------
  loadHeaderCache() {
    this.loadSenderRules();
    this.headers = new Map();
    const rows = this.db.prepare(`SELECT m.id, m.account_id, m.project_id, m.folder_id, m.uid, m.date, m.seen, m.flagged,
      m.important, m.has_attachments, m.size, m.header, m.thread_key, m.trust, m.ai_important, m.ai_note, m.ai_checked, m.category, m.category_locked, m.remote_id, m.delivery, m.raw IS NOT NULL AS cached, f.role
      FROM messages m JOIN folders f ON f.id = m.folder_id`).all();
    for (const row of rows) this.cacheHeader(row);
    this.sortHeaders();
  }

  cacheHeader(row) {
    const header = this.vault.decryptJson(row.header);
    const entry = {
      id: row.id,
      accountId: row.account_id,
      projectId: row.project_id,
      folderId: row.folder_id,
      folderRole: row.role,
      uid: row.uid,
      date: new Date(row.date).toISOString(),
      dateValue: row.date,
      read: Boolean(row.seen),
      flagged: Boolean(row.flagged),
      important: Boolean(row.important),
      hasAttachments: Boolean(row.has_attachments),
      size: row.size,
      cached: Boolean(row.cached),
      ...header,
    };
    entry.threadKey = row.thread_key || this.vault.fingerprint(threadRoot(header, row.id));
    // Older rows have no stored verdict yet: the subject and folder already tell spam apart.
    entry.serverTrust = row.trust || classifyTrust({ subject: header.subject, from: header.from, fromAddress: header.fromAddress, folderRole: row.role });
    entry.aiImportant = Boolean(row.ai_important);
    entry.aiChecked = Boolean(row.ai_checked);
    entry.aiNote = row.ai_note ? this.vault.decryptJson(row.ai_note) : null;
    entry.autoCategory = CATEGORIES.includes(row.category) ? row.category : categorize(header);
    entry.categoryLocked = Boolean(row.category_locked);
    entry.remoteId = row.remote_id || null;
    entry.delivery = row.delivery || '';
    this.applySenderRule(entry);
    entry.search = searchText(entry);
    this.headers.set(row.id, entry);
    return entry;
  }

  sortHeaders() {
    this.sorted = [...this.headers.values()].sort((a, b) => b.dateValue - a.dateValue);
  }

  // Sender rules: "not spam" / "spam" and "always in this tab", keyed by a fingerprint of the address.
  loadSenderRules() {
    this.senderRules = new Map(this.db.prepare('SELECT fingerprint, category, verdict FROM sender_rules').all()
      .map((r) => [r.fingerprint, { category: r.category, verdict: r.verdict }]));
  }

  senderRule(address) {
    if (!address || !this.senderRules?.size) return null;
    return this.senderRules.get(this.vault.fingerprint(address)) || null;
  }

  /** The reader's own choices win over the server's spam verdict and over the automatic tab. */
  applySenderRule(entry) {
    const rule = this.senderRule(entry.fromAddress);
    entry.category = CATEGORIES.includes(rule?.category) ? rule.category : entry.autoCategory;
    let trust = entry.serverTrust || '';
    // "Not spam" is keyed on the From address, which anyone can fake, so it only lifts the
    // spam filter's verdict. A failed sender check ('suspicious') always stays visible.
    if (rule?.verdict === 'safe' && trust === 'spam' && entry.folderRole !== 'junk') trust = '';
    if (rule?.verdict === 'spam' && trust !== 'spam') trust = 'spam';
    entry.trust = trust;
    return entry;
  }

  setSenderRule(address, changes) {
    if (!address) return 0;
    const fingerprint = this.vault.fingerprint(address);
    const current = this.senderRules.get(fingerprint) || { category: '', verdict: '' };
    const next = { ...current, ...changes };
    if (!next.category && !next.verdict) {
      this.db.prepare('DELETE FROM sender_rules WHERE fingerprint = ?').run(fingerprint);
      this.senderRules.delete(fingerprint);
    } else {
      this.db.prepare(`INSERT INTO sender_rules (fingerprint, category, verdict) VALUES (?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET category = excluded.category, verdict = excluded.verdict`).run(fingerprint, next.category, next.verdict);
      this.senderRules.set(fingerprint, next);
    }
    let changed = 0;
    const needle = String(address).toLowerCase().trim();
    for (const header of this.headers.values()) {
      if (String(header.fromAddress || '').toLowerCase().trim() === needle) { this.applySenderRule(header); changed += 1; }
    }
    return changed;
  }

  /** Gmail's own tabs for these UIDs; every other message of the window is in Primary. */
  setGmailCategories(folderId, minUid, byUid) {
    const update = this.db.prepare('UPDATE messages SET category = ?, category_locked = 1 WHERE id = ?');
    this.transaction(() => {
      for (const header of this.sorted) {
        if (header.folderId !== folderId || header.uid < minUid) continue;
        const category = byUid.get(header.uid) || 'primary';
        if (header.autoCategory === category && header.categoryLocked) continue;
        update.run(category, header.id);
        header.autoCategory = category;
        header.categoryLocked = true;
        this.applySenderRule(header);
      }
    });
  }

  // Accounts without IMAP (Resend) ---------------------------------------------
  knownRemoteIds(accountId) {
    const ids = new Set(this.db.prepare('SELECT remote_id FROM messages WHERE account_id = ? AND remote_id IS NOT NULL').all(accountId).map((r) => r.remote_id));
    for (const row of this.db.prepare('SELECT remote_id FROM remote_gone WHERE account_id = ?').all(accountId)) ids.add(row.remote_id);
    return ids;
  }

  nextUid(folderId) {
    return (this.db.prepare('SELECT MAX(uid) AS uid FROM messages WHERE folder_id = ?').get(folderId)?.uid || 0) + 1;
  }

  /** Move a stored message to another folder of the same account, on this computer only. */
  moveLocal(id, targetFolderId) {
    const header = this.getMessage(id);
    const target = this.getFolder(targetFolderId);
    if (!target || target.account_id !== header.accountId) throw new Error('Choose another folder in the same account.');
    const uid = this.nextUid(target.id);
    const newId = `${target.account_id}:${target.id}:${uid}`;
    this.transaction(() => {
      this.db.prepare(`INSERT INTO messages (id, account_id, project_id, folder_id, uid, date, seen, flagged, important, has_attachments, size, header, raw,
        thread_key, trust, ai_important, ai_checked, ai_note, category, category_locked, remote_id, delivery)
        SELECT ?, account_id, project_id, ?, ?, date, seen, flagged, important, has_attachments, size, header, raw,
        thread_key, trust, ai_important, ai_checked, ai_note, category, category_locked, remote_id, delivery FROM messages WHERE id = ?`).run(newId, target.id, uid, id);
      this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    });
    this.headers.delete(id);
    this.headers.set(newId, { ...header, id: newId, folderId: target.id, folderRole: target.role, uid });
    this.applySenderRule(this.headers.get(newId));
    this.sortHeaders();
    return newId;
  }

  /** Remember a provider message the reader deleted for good, so the next sync does not bring it back. */
  /** Update the delivery status of sent mail from the provider's list (remoteId -> status). */
  setDeliveries(accountId, statuses) {
    const update = this.db.prepare('UPDATE messages SET delivery = ? WHERE id = ?');
    let changed = 0;
    this.transaction(() => {
      for (const header of this.headers.values()) {
        if (header.accountId !== accountId || !header.remoteId) continue;
        const status = statuses.get(header.remoteId);
        if (!status || status === header.delivery) continue;
        update.run(status, header.id);
        header.delivery = status;
        changed += 1;
      }
    });
    return changed;
  }

  forgetRemote(accountId, remoteId) {
    if (remoteId) this.db.prepare('INSERT OR IGNORE INTO remote_gone (account_id, remote_id) VALUES (?, ?)').run(accountId, remoteId);
  }

  setSeenLocal(ids, seen) {
    const update = this.db.prepare('UPDATE messages SET seen = ? WHERE id = ?');
    this.transaction(() => ids.forEach((id) => { update.run(seen ? 1 : 0, id); const h = this.headers.get(id); if (h) h.read = Boolean(seen); }));
  }

  insertMessages(folder, messages) {
    if (!messages.length) return [];
    const insert = this.db.prepare(`INSERT OR IGNORE INTO messages
      (id, account_id, project_id, folder_id, uid, date, seen, flagged, important, has_attachments, size, header, thread_key, trust, category, remote_id, raw, delivery)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const added = [];
    this.transaction(() => {
      for (const message of messages) {
        const id = `${folder.account_id}:${folder.id}:${message.uid}`;
        const header = {
          subject: message.subject, from: message.from, fromAddress: message.fromAddress, to: message.to, cc: message.cc,
          messageId: message.messageId, inReplyTo: message.inReplyTo, references: message.references || '', preview: message.preview || '',
        };
        const row = {
          id, account_id: folder.account_id, project_id: message.projectId, folder_id: folder.id, uid: message.uid,
          date: message.dateValue, seen: message.read ? 1 : 0, flagged: message.flagged ? 1 : 0, important: message.important ? 1 : 0,
          has_attachments: message.hasAttachments ? 1 : 0, size: message.size || 0, header: this.vault.encryptJson(header),
          thread_key: this.vault.fingerprint(threadRoot(header, id)),
          trust: message.trust || '',
          category: CATEGORIES.includes(message.category) ? message.category : categorize(message),
          remote_id: message.remoteId || null,
          raw: message.raw ? this.vault.encrypt(message.raw) : null,
          delivery: message.delivery || '',
        };
        const result = insert.run(row.id, row.account_id, row.project_id, row.folder_id, row.uid, row.date, row.seen, row.flagged,
          row.important, row.has_attachments, row.size, row.header, row.thread_key, row.trust, row.category, row.remote_id, row.raw, row.delivery);
        if (result.changes) added.push(this.cacheHeader({ ...row, cached: row.raw ? 1 : 0, role: folder.role }));
      }
    });
    this.sortHeaders();
    return added;
  }

  /** Apply server flags and drop messages that no longer exist on the server (within the synced UID range). */
  reconcileFolder(folder, serverState, minUid) {
    const update = this.db.prepare('UPDATE messages SET seen = ?, flagged = ? WHERE id = ?');
    const remove = this.db.prepare('DELETE FROM messages WHERE id = ?');
    const local = this.db.prepare('SELECT id, uid FROM messages WHERE folder_id = ? AND uid >= ?').all(folder.id, minUid);
    let changed = false;
    this.transaction(() => {
      for (const row of local) {
        const state = serverState.get(row.uid);
        const cached = this.headers.get(row.id);
        if (!state) {
          remove.run(row.id);
          this.headers.delete(row.id);
          changed = true;
        } else if (cached && (cached.read !== state.seen || cached.flagged !== state.flagged)) {
          update.run(state.seen ? 1 : 0, state.flagged ? 1 : 0, row.id);
          cached.read = state.seen;
          cached.flagged = state.flagged;
          changed = true;
        }
      }
    });
    if (changed) this.sortHeaders();
    return changed;
  }

  getMessage(id) {
    const header = this.headers.get(id);
    if (!header) throw new Error('Message not found.');
    return header;
  }

  getRaw(id) {
    const row = this.db.prepare('SELECT raw FROM messages WHERE id = ?').get(id);
    return row?.raw ? this.vault.decrypt(row.raw) : null;
  }

  setRaw(id, raw, preview) {
    const header = this.getMessage(id);
    if (preview !== undefined) header.preview = preview;
    const { subject, from, fromAddress, to, cc, messageId, inReplyTo, references } = header;
    this.db.prepare('UPDATE messages SET raw = ?, header = ? WHERE id = ?').run(
      this.vault.encrypt(raw),
      this.vault.encryptJson({ subject, from, fromAddress, to, cc, messageId, inReplyTo, references, preview: header.preview }),
      id,
    );
    header.cached = true;
    header.search = searchText(header);
  }

  /** Re-check trust once the full message (with every header) is available. */
  refreshTrust(id, raw, { dkimDomains = [] } = {}) {
    const header = this.headers.get(id);
    if (!header) return false;
    const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
    const end = text.search(/\r?\n\r?\n/);
    let authServers = [];
    try { authServers = trustedAuthServers(this.getAccount(header.accountId)); } catch { /* account removed */ }
    const headerBlock = end > 0 ? text.slice(0, end) : text.slice(0, 20000);
    if (!header.categoryLocked) {
      const category = categorize({ ...header, headers: headerBlock });
      if (category !== header.autoCategory) {
        this.db.prepare('UPDATE messages SET category = ? WHERE id = ?').run(category, id);
        header.autoCategory = category;
        this.applySenderRule(header);
      }
    }
    const trust = classifyTrust({
      subject: header.subject, from: header.from, fromAddress: header.fromAddress, folderRole: header.folderRole,
      headers: headerBlock, authServers, dkimDomains,
    });
    if (trust === header.serverTrust) return false;
    this.db.prepare('UPDATE messages SET trust = ? WHERE id = ?').run(trust, id);
    header.serverTrust = trust;
    this.applySenderRule(header);
    return true;
  }

  /** Check the DKIM signature in the background, then update the verdict. */
  verifyTrustLater(id, raw, verify) {
    verify(raw).then((dkimDomains) => {
      if (dkimDomains.length) this.refreshTrust(id, raw, { dkimDomains });
    }).catch(() => {});
  }

  /** The assistant's verdict: important or not, with a short encrypted reason. */
  setAiVerdict(id, { important, category = '', reason = '' }) {
    const header = this.getMessage(id);
    const note = important ? { category, reason } : null;
    this.db.prepare('UPDATE messages SET ai_checked = 1, ai_important = ?, ai_note = ? WHERE id = ?')
      .run(important ? 1 : 0, note ? this.vault.encryptJson(note) : null, id);
    header.aiImportant = Boolean(important);
    header.aiNote = note;
    header.aiChecked = true;
  }

  /** Recent inbox messages the assistant has not looked at yet (spam and suspicious mail are skipped). */
  messagesForTriage(sinceMs, limit = 25) {
    return this.sorted.filter((m) => m.folderRole === 'inbox' && m.dateValue >= sinceMs && !m.aiChecked
      && !['spam', 'suspicious'].includes(m.trust)).slice(0, limit);
  }

  setSeen(id, seen) {
    const header = this.getMessage(id);
    this.db.prepare('UPDATE messages SET seen = ? WHERE id = ?').run(seen ? 1 : 0, id);
    header.read = Boolean(seen);
  }

  deleteMessage(id) {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    this.headers.delete(id);
    this.sortHeaders();
  }

  messagesToPrefetch(accountId, limit) {
    // Never download again what the retention policy just freed: only recent mail is kept offline.
    const since = this.bodyCutoff();
    return this.sorted.filter((m) => m.accountId === accountId && !m.cached && m.size < 5 * 1024 * 1024 && m.dateValue >= since).slice(0, limit);
  }

  // Reminders and snooze -----------------------------------------------------------
  /** The thread key a message will have once it is synced (same rule as cacheHeader). */
  threadKeyFor(header, id = '') {
    return this.vault.fingerprint(threadRoot(header, id));
  }

  addReminder({ kind, accountId, threadKey, dueAt, data = {} }) {
    const id = this.id();
    this.db.prepare('INSERT INTO reminders (id, kind, account_id, thread_key, due_at, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, kind, accountId, threadKey, dueAt, 'waiting', Date.now(), this.vault.encryptJson(data));
    this.loadReminderCache();
    return id;
  }

  listReminders() {
    return this.db.prepare('SELECT * FROM reminders ORDER BY due_at').all().map((row) => ({
      id: row.id, kind: row.kind, accountId: row.account_id, threadKey: row.thread_key, dueAt: row.due_at,
      status: row.status, createdAt: row.created_at, ...this.vault.decryptJson(row.data),
    }));
  }

  getReminder(id) {
    const reminder = this.listReminders().find((r) => r.id === id);
    if (!reminder) throw new Error('Reminder not found.');
    return reminder;
  }

  updateReminder(id, { status, dueAt, data }) {
    const current = this.getReminder(id);
    const { id: _id, kind, accountId, threadKey, dueAt: _due, status: _status, createdAt, ...stored } = current;
    this.db.prepare('UPDATE reminders SET status = ?, due_at = ?, data = ? WHERE id = ?')
      .run(status ?? current.status, dueAt ?? current.dueAt, this.vault.encryptJson({ ...stored, ...(data || {}) }), id);
    this.loadReminderCache();
  }

  removeReminder(id) {
    this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
    this.loadReminderCache();
  }

  /**
   * In memory: conversations hidden by snooze, and those just back from snooze, which
   * sort to the top of the inbox (by the time they came back) until they are opened.
   */
  loadReminderCache() {
    this.snoozed = new Set();
    this.bumped = new Map();
    for (const row of this.db.prepare("SELECT account_id, thread_key, status, due_at FROM reminders WHERE kind = 'snooze' AND status IN ('waiting', 'returned')").all()) {
      const key = `${row.account_id}:${row.thread_key}`;
      if (row.status === 'waiting') this.snoozed.add(key);
      else this.bumped.set(key, Math.max(this.bumped.get(key) || 0, row.due_at));
    }
  }

  isSnoozed(message) {
    return this.snoozed.size > 0 && this.snoozed.has(`${message.accountId}:${message.threadKey}`);
  }

  /**
   * Which follow-ups got an answer: a message from someone else, after the reader's mail, in
   * the same conversation, or from one of its recipients with the same subject (some
   * senders and services break the thread headers). One pass over the headers.
   * watch: [{ id, threadKey, since, recipients: Set<address>, subject }]
   */
  repliedReminders(watch, ownAddresses) {
    const replied = new Set();
    if (!watch.length) return replied;
    const byKey = new Map();
    const bySubject = new Map();
    for (const item of watch) {
      if (!byKey.has(item.threadKey)) byKey.set(item.threadKey, []);
      byKey.get(item.threadKey).push(item);
      if (item.subject) {
        if (!bySubject.has(item.subject)) bySubject.set(item.subject, []);
        bySubject.get(item.subject).push(item);
      }
    }
    for (const m of this.sorted) {
      if (['sent', 'drafts', 'trash', 'junk'].includes(m.folderRole) || !m.fromAddress) continue;
      const from = String(m.fromAddress).toLowerCase();
      if (ownAddresses.has(from)) continue;
      for (const item of byKey.get(m.threadKey) || []) if (m.dateValue > item.since - 60_000) replied.add(item.id);
      const subject = bySubject.size ? replySubject(m.subject) : '';
      for (const item of (subject && bySubject.get(subject)) || []) {
        if (m.dateValue > item.since - 60_000 && item.recipients.has(from)) replied.add(item.id);
      }
    }
    return replied;
  }

  /** Opening a conversation that came back from snooze ends its place at the top. */
  clearReturned(accountId, threadKey) {
    const result = this.db.prepare("DELETE FROM reminders WHERE kind = 'snooze' AND status = 'returned' AND account_id = ? AND thread_key = ?").run(accountId, threadKey);
    if (result.changes) this.loadReminderCache();
    return result.changes > 0;
  }

  /** The newest message of a conversation, to open it from a reminder. */
  latestInThread(accountId, threadKey) {
    return this.sorted.find((m) => m.accountId === accountId && m.threadKey === threadKey && !['trash', 'junk'].includes(m.folderRole))
      || this.sorted.find((m) => m.threadKey === threadKey && !['trash', 'junk'].includes(m.folderRole)) || null;
  }

  // Storage ----------------------------------------------------------------------
  /** Oldest date whose full message is kept on this device (0 = keep everything). */
  bodyCutoff(now = Date.now()) {
    const days = this.getSetting('preferences', {})?.bodyCacheDays ?? DEFAULT_BODY_DAYS;
    return days > 0 ? now - days * 86_400_000 : 0;
  }

  /**
   * Drop the full copy (body and attachments) of mail older than the retention period.
   * The headers stay, so the message still lists and searches; opening it fetches it again.
   * Starred mail and accounts whose server cannot hand the message back are left alone.
   */
  freeOldBodies(accountIds, now = Date.now()) {
    const cutoff = this.bodyCutoff(now);
    if (!cutoff || !accountIds.length) return 0;
    const marks = accountIds.map(() => '?').join(',');
    const where = `raw IS NOT NULL AND date < ? AND flagged = 0 AND account_id IN (${marks})`;
    const ids = this.db.prepare(`SELECT id FROM messages WHERE ${where}`).all(cutoff, ...accountIds).map((r) => r.id);
    if (!ids.length) return 0;
    this.db.prepare(`UPDATE messages SET raw = NULL WHERE ${where}`).run(cutoff, ...accountIds);
    for (const id of ids) {
      const header = this.headers.get(id);
      if (header) header.cached = false;
    }
    return ids.length;
  }

  storageInfo() {
    const pragma = (name) => Number(Object.values(this.db.prepare(`PRAGMA ${name}`).get())[0]) || 0;
    const pageSize = pragma('page_size');
    const bodies = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(raw)), 0) AS bytes FROM messages WHERE raw IS NOT NULL').get();
    return {
      fileBytes: pragma('page_count') * pageSize,
      freeBytes: pragma('freelist_count') * pageSize,
      bodyBytes: Number(bodies.bytes),
      bodies: Number(bodies.n),
      messages: this.headers.size,
    };
  }

  /**
   * Give freed space back to the disk. The first time this rebuilds the file once
   * (VACUUM) and turns on incremental vacuum, so later calls are quick.
   */
  compact({ full = false } = {}) {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const incremental = Number(Object.values(this.db.prepare('PRAGMA auto_vacuum').get())[0]) === 2;
    if (incremental && !full) {
      this.db.exec('PRAGMA incremental_vacuum');
    } else if (full) {
      if (!incremental) this.db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      this.db.exec('VACUUM');
    }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * List conversations. A conversation appears once, represented by its newest
   * message in the selected folder(s), with a count and unread/flag summary.
   */
  listMessages({ projectId = 'all', accountId = 'all', folderId = null, folderRole = 'inbox', filter = 'all', query = '', offset = 0, limit = 200, threaded = true, category = '' } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    const serverHits = needle ? this.searchHits?.get(needle) : null;
    const wordsMatch = searchMatcher(needle);
    // Tabs only make sense for an inbox that is not being searched.
    const folderIsInbox = folderId ? this.getFolder(folderId)?.role === 'inbox' : folderRole === 'inbox';
    const tabbed = Boolean(folderIsInbox && !needle && CATEGORIES.includes(category));
    const tabs = tabbed ? Object.fromEntries(CATEGORIES.map((c) => [c, { unread: 0, total: 0 }])) : null;
    // Snoozed conversations leave the inbox until they come back; search still finds them.
    const hideSnoozed = folderIsInbox && !needle;
    const all = this.sorted.filter((m) => {
      if (hideSnoozed && this.isSnoozed(m)) return false;
      const anyFolder = needle || folderRole === 'any';
      if (folderId ? m.folderId !== folderId : (anyFolder ? ['trash', 'junk'].includes(m.folderRole) : m.folderRole !== folderRole)) return false;
      if (projectId !== 'all' && m.projectId !== projectId) return false;
      if (accountId !== 'all' && m.accountId !== accountId) return false;
      if (filter === 'unread' && m.read) return false;
      if (filter === 'important' && !isImportantMessage(m)) return false;
      if (filter === 'spam' && !['spam', 'suspicious'].includes(m.trust)) return false;
      if (filter === 'flagged' && !m.flagged) return false;
      if (filter === 'attachments' && !m.hasAttachments) return false;
      return !wordsMatch || wordsMatch(m.search) || Boolean(serverHits?.has(m.id));
    });
    let matches = all;
    if (tabbed) {
      for (const m of all) {
        const tab = tabs[m.category] || tabs.primary;
        tab.total += 1;
        if (!m.read && m.trust !== 'spam') tab.unread += 1;
      }
      matches = all.filter((m) => (m.category || 'primary') === category);
    }
    // Conversations: one entry per thread, represented by its newest message. Only light
    // records are built here; full rows are made for the visible page alone (large
    // mailboxes have tens of thousands of conversations).
    let items = matches;
    if (threaded) {
      const threads = new Map();
      for (const message of matches) {
        const key = `${message.accountId}:${message.threadKey}`;
        const thread = threads.get(key);
        const messageKey = message.messageId || message.id;
        if (!thread) threads.set(key, { head: message, count: 1, unread: !message.read, flagged: message.flagged, firstKey: messageKey, seen: null });
        else {
          thread.seen ||= new Set([thread.firstKey]);
          if (!thread.seen.has(messageKey)) { thread.seen.add(messageKey); thread.count += 1; }
          thread.unread ||= !message.read;
          thread.flagged ||= message.flagged;
        }
      }
      items = [...threads.values()];
    }
    const head = (item) => (threaded ? item.head : item);
    if (folderIsInbox && !needle && this.bumped.size) {
      const at = (item) => Math.max(head(item).dateValue, this.bumped.get(`${head(item).accountId}:${head(item).threadKey}`) || 0);
      items = [...items].sort((a, b) => at(b) - at(a));
    }
    const row = (item) => {
      const { search, dateValue, autoCategory, serverTrust, ...message } = head(item);
      return threaded ? { ...message, threadCount: item.count, threadUnread: item.unread, threadFlagged: item.flagged } : message;
    };
    return {
      total: items.length,
      tabs,
      messages: items.slice(offset, offset + limit).map(row),
    };
  }

  /** All messages of a conversation in one account, oldest first, across folders. */
  threadMessages(id) {
    const anchor = this.getMessage(id);
    const excludeBin = !['trash', 'junk'].includes(anchor.folderRole);
    const seen = new Set();
    return this.sorted
      .filter((m) => m.accountId === anchor.accountId && m.threadKey === anchor.threadKey && !(excludeBin && ['trash', 'junk'].includes(m.folderRole)))
      .filter((m) => {
        const key = m.messageId || m.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .reverse();
  }

  setFlagged(id, flagged) {
    const header = this.getMessage(id);
    this.db.prepare('UPDATE messages SET flagged = ? WHERE id = ?').run(flagged ? 1 : 0, id);
    header.flagged = Boolean(flagged);
  }

  // Contacts (derived from synced headers; never stored separately) -------------
  searchContacts(query, limit = 8) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return [];
    const folded = normalizeSearch(needle);
    const contacts = new Map();
    for (const message of this.sorted) {
      for (const field of [message.from, message.to, message.cc]) {
        for (const contact of parseAddressList(field)) {
          const entry = contacts.get(contact.address) || { address: contact.address, name: '', score: 0 };
          entry.score += message.folderRole === 'sent' ? 3 : 1;
          if (!entry.name && contact.name) entry.name = contact.name;
          contacts.set(contact.address, entry);
        }
      }
    }
    return [...contacts.values()]
      .filter((c) => c.address.includes(needle) || normalizeSearch(c.name).includes(folded))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ address, name }) => ({ address, name }));
  }

  // Signatures -----------------------------------------------------------------
  listSignatures() {
    return this.db.prepare('SELECT id, created_at, data FROM signatures ORDER BY created_at').all()
      .map((row) => ({ id: row.id, ...this.vault.decryptJson(row.data) }));
  }

  saveSignature({ id, name, html }) {
    const signatureId = id || this.id();
    this.db.prepare(`INSERT INTO signatures (id, created_at, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(signatureId, Date.now(), this.vault.encryptJson({ name, html }));
    return signatureId;
  }

  deleteSignature(id) {
    this.db.prepare('DELETE FROM signatures WHERE id = ?').run(id);
  }

  unreadCounts() {
    const counts = { total: 0, projects: {}, accounts: {}, important: 0 };
    for (const message of this.sorted) {
      // Spam is not counted: it should not make a mailbox look busy.
      if (message.read || message.folderRole !== 'inbox' || message.trust === 'spam' || this.isSnoozed(message)) continue;
      counts.total += 1;
      if (isImportantMessage(message)) counts.important += 1;
      counts.projects[message.projectId] = (counts.projects[message.projectId] || 0) + 1;
      counts.accounts[message.accountId] = (counts.accounts[message.accountId] || 0) + 1;
    }
    return counts;
  }

  // Drafts -------------------------------------------------------------------
  listDrafts() {
    return this.db.prepare('SELECT id, account_id, updated_at, data FROM drafts ORDER BY updated_at DESC').all()
      .map((row) => ({ id: row.id, accountId: row.account_id, updatedAt: new Date(row.updated_at).toISOString(), ...this.vault.decryptJson(row.data) }));
  }

  getDraft(id) {
    const draft = this.listDrafts().find((item) => item.id === id);
    if (!draft) throw new Error('Draft not found.');
    return draft;
  }

  saveDraft(draft) {
    const id = draft.id || this.id();
    const { id: _id, accountId, updatedAt, ...data } = draft;
    this.db.prepare(`INSERT INTO drafts (id, account_id, updated_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id, updated_at = excluded.updated_at, data = excluded.data`)
      .run(id, accountId, Date.now(), this.vault.encryptJson(data));
    return this.getDraft(id);
  }

  deleteDraft(id) {
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
  }

  // Outbox -------------------------------------------------------------------
  enqueueOutbox(accountId, payload, sendAt = Date.now()) {
    const id = this.id();
    this.db.prepare(`INSERT INTO outbox (id, account_id, status, attempts, next_attempt_at, created_at, data)
      VALUES (?, ?, 'queued', 0, ?, ?, ?)`).run(id, accountId, sendAt, Date.now(), this.vault.encryptJson(payload));
    return id;
  }

  listOutbox() {
    return this.db.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 200').all().map((row) => this.decodeOutbox(row));
  }

  dueOutbox(now = Date.now()) {
    return this.db.prepare(`SELECT * FROM outbox WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY created_at`).all(now)
      .map((row) => this.decodeOutbox(row));
  }

  decodeOutbox(row) {
    return {
      id: row.id, accountId: row.account_id, status: row.status, attempts: row.attempts, nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error, createdAt: row.created_at, sentAt: row.sent_at, ...this.vault.decryptJson(row.data),
    };
  }

  updateOutbox(id, { status, attempts, nextAttemptAt, lastError = null, sentAt = null }) {
    this.db.prepare('UPDATE outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, sent_at = ? WHERE id = ?')
      .run(status, attempts, nextAttemptAt, lastError, sentAt, id);
  }

  removeOutbox(id) {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }

  // Audit --------------------------------------------------------------------
  audit(action, details = {}) {
    this.db.prepare('INSERT INTO audit (id, at, action, details) VALUES (?, ?, ?, ?)')
      .run(this.id(), Date.now(), action, this.vault.encryptJson(details));
    this.db.prepare(`DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY at DESC LIMIT ${AUDIT_LIMIT})`).run();
  }

  listAudit(limit = 300) {
    return this.db.prepare('SELECT * FROM audit ORDER BY at DESC LIMIT ?').all(limit)
      .map((row) => ({ id: row.id, at: new Date(row.at).toISOString(), action: row.action, details: this.vault.decryptJson(row.details) }));
  }

  // Remote images ------------------------------------------------------------
  isTrustedImageSender(address) {
    if (!address) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM trusted_image_senders WHERE fingerprint = ?').get(this.vault.fingerprint(address)));
  }

  trustImageSender(address) {
    this.db.prepare('INSERT OR IGNORE INTO trusted_image_senders (fingerprint) VALUES (?)').run(this.vault.fingerprint(address));
  }
}

module.exports = { Database, parseAddressList, normalizeSearch, replySubject };
