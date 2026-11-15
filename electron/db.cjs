const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 2;
const AUDIT_LIMIT = 1000;

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
`;

function searchText(header) {
  return [header.subject, header.from, header.to, header.cc, header.preview].filter(Boolean).join(' ').toLowerCase();
}

const ADDRESS = /(?:"?([^"<,]*?)"?\s*)?<?([^\s<>,;"]+@[^\s<>,;"]+)>?/g;

function parseAddressList(value = '') {
  const result = [];
  for (const match of String(value).matchAll(ADDRESS)) {
    const address = match[2].toLowerCase();
    const name = (match[1] || '').trim();
    result.push({ name: name && name.toLowerCase() !== address ? name : '', address });
  }
  return result;
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
  }

  upgradeSchema() {
    const columns = (table) => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!columns('folders').has('name')) this.db.exec('ALTER TABLE folders ADD COLUMN name TEXT');
    if (!columns('messages').has('thread_key')) this.db.exec('ALTER TABLE messages ADD COLUMN thread_key TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_key)');
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

  // Projects -----------------------------------------------------------------
  listProjects() {
    return this.db.prepare('SELECT id, created_at, data FROM projects ORDER BY created_at').all()
      .map((row) => ({ id: row.id, createdAt: row.created_at, ...this.vault.decryptJson(row.data) }));
  }

  createProject({ name, color }, id = this.id(), createdAt = Date.now()) {
    this.db.prepare('INSERT INTO projects (id, created_at, data) VALUES (?, ?, ?)')
      .run(id, createdAt, this.vault.encryptJson({ name, color }));
    return id;
  }

  deleteProject(id) {
    const used = this.db.prepare('SELECT 1 FROM accounts WHERE project_id = ? LIMIT 1').get(id);
    if (used) throw new Error('Delete the project accounts first.');
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  // Accounts -----------------------------------------------------------------
  listAccounts({ withSecrets = false } = {}) {
    return this.db.prepare('SELECT id, project_id, created_at, data FROM accounts ORDER BY created_at').all()
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
    if (!withSecrets) delete account.password;
    return account;
  }

  createAccount(account, id = this.id(), createdAt = Date.now()) {
    const { projectId, ...data } = account;
    this.db.prepare('INSERT INTO accounts (id, project_id, created_at, data) VALUES (?, ?, ?, ?)')
      .run(id, projectId, createdAt, this.vault.encryptJson(data));
    return id;
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
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    });
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
    return this.db.prepare('SELECT id, account_id, path, role, name FROM folders ORDER BY account_id, id').all()
      .map((f) => ({ id: f.id, accountId: f.account_id, path: f.path, role: f.role, name: f.name || f.path, unread: unread[f.id] || 0, total: totals[f.id] || 0 }));
  }

  getFolder(id) {
    return this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  }

  setFolderState(id, { uidValidity, lastUid }) {
    this.db.prepare('UPDATE folders SET uid_validity = ?, last_uid = ? WHERE id = ?').run(uidValidity, lastUid, id);
  }

  resetFolder(id) {
    this.db.prepare('DELETE FROM messages WHERE folder_id = ?').run(id);
    this.db.prepare('UPDATE folders SET uid_validity = NULL, last_uid = 0 WHERE id = ?').run(id);
    for (const [key, header] of this.headers) if (header.folderId === id) this.headers.delete(key);
    this.sortHeaders();
  }

  // Messages -----------------------------------------------------------------
  loadHeaderCache() {
    this.headers = new Map();
    const rows = this.db.prepare(`SELECT m.id, m.account_id, m.project_id, m.folder_id, m.uid, m.date, m.seen, m.flagged,
      m.important, m.has_attachments, m.size, m.header, m.thread_key, m.raw IS NOT NULL AS cached, f.role
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
    entry.search = searchText(entry);
    this.headers.set(row.id, entry);
    return entry;
  }

  sortHeaders() {
    this.sorted = [...this.headers.values()].sort((a, b) => b.dateValue - a.dateValue);
  }

  insertMessages(folder, messages) {
    if (!messages.length) return [];
    const insert = this.db.prepare(`INSERT OR IGNORE INTO messages
      (id, account_id, project_id, folder_id, uid, date, seen, flagged, important, has_attachments, size, header, thread_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
        };
        const result = insert.run(row.id, row.account_id, row.project_id, row.folder_id, row.uid, row.date, row.seen, row.flagged,
          row.important, row.has_attachments, row.size, row.header, row.thread_key);
        if (result.changes) added.push(this.cacheHeader({ ...row, cached: 0, role: folder.role }));
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
    return this.sorted.filter((m) => m.accountId === accountId && !m.cached && m.size < 5 * 1024 * 1024).slice(0, limit);
  }

  /**
   * List conversations. A conversation appears once, represented by its newest
   * message in the selected folder(s), with a count and unread/flag summary.
   */
  listMessages({ projectId = 'all', accountId = 'all', folderId = null, folderRole = 'inbox', filter = 'all', query = '', offset = 0, limit = 200, threaded = true } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    const matches = this.sorted.filter((m) => {
      if (folderId ? m.folderId !== folderId : (needle ? ['trash', 'junk'].includes(m.folderRole) : m.folderRole !== folderRole)) return false;
      if (projectId !== 'all' && m.projectId !== projectId) return false;
      if (accountId !== 'all' && m.accountId !== accountId) return false;
      if (filter === 'unread' && m.read) return false;
      if (filter === 'important' && !m.important) return false;
      if (filter === 'flagged' && !m.flagged) return false;
      if (filter === 'attachments' && !m.hasAttachments) return false;
      return !needle || m.search.includes(needle);
    });
    let items = matches;
    if (threaded) {
      const threads = new Map();
      for (const message of matches) {
        const key = `${message.accountId}:${message.threadKey}`;
        const thread = threads.get(key);
        if (!thread) threads.set(key, { ...message, threadCount: 1, threadUnread: !message.read, threadFlagged: message.flagged });
        else {
          thread.threadCount += 1;
          thread.threadUnread ||= !message.read;
          thread.threadFlagged ||= message.flagged;
        }
      }
      items = [...threads.values()];
    }
    return {
      total: items.length,
      messages: items.slice(offset, offset + limit).map(({ search, dateValue, ...message }) => message),
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
      .filter((c) => c.address.includes(needle) || c.name.toLowerCase().includes(needle))
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
    const counts = { total: 0, projects: {}, accounts: {} };
    for (const message of this.sorted) {
      if (message.read || message.folderRole !== 'inbox') continue;
      counts.total += 1;
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

module.exports = { Database };
