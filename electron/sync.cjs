const { ImapFlow } = require('imapflow');
const { imapConfig, parseRawMessage, summarizeFetched } = require('./mail.cjs');
const { classifyTrust, trustedAuthServers } = require('./core.cjs');
const { verifiedDkimDomains } = require('./dkim.cjs');

const INITIAL_WINDOW = 500;
const RECONCILE_WINDOW = 1000;
const PREFETCH_BODIES = 40;
const OLDER_BATCH = 500;
const SEARCH_LIMIT = 200;
const PERIODIC_SYNC_MS = 5 * 60_000;
const RECONNECT_DELAYS = [5_000, 15_000, 60_000, 5 * 60_000];
const MAX_PARALLEL_SYNCS = 3;

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }

  async use(work) {
    if (this.active >= this.limit) await new Promise((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

const SPECIAL_USE = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Trash': 'trash', '\\Junk': 'junk', '\\Drafts': 'drafts', '\\Archive': 'archive', '\\All': 'all',
};

function folderRole(folder) {
  if (folder.path.toUpperCase() === 'INBOX') return 'inbox';
  if (SPECIAL_USE[folder.specialUse]) return SPECIAL_USE[folder.specialUse];
  const name = folder.path.replace(/^inbox[./]/i, '');
  if (/^(sent|sent items|sent messages|sent mail|\[gmail\]\/sent mail)$/i.test(name)) return 'sent';
  if (/^(trash|deleted|deleted items|deleted messages|bin|\[gmail\]\/trash|\[gmail\]\/bin)$/i.test(name)) return 'trash';
  if (/^(junk|spam|junk e-mail|bulk mail|\[gmail\]\/spam)$/i.test(name)) return 'junk';
  if (/^(drafts|\[gmail\]\/drafts)$/i.test(name)) return 'drafts';
  if (/^(archive|archives)$/i.test(name)) return 'archive';
  return 'custom';
}

const TRUST_HEADERS = ['references', 'x-spam-flag', 'x-spam-status', 'x-spam', 'x-ms-exchange-organization-scl', 'authentication-results'];

function parseReferences(headers) {
  if (!headers) return '';
  const text = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
  const match = text.match(/^references:\s*(.*)$/im);
  return match ? match[1].trim() : '';
}

const FETCH_QUERY = { uid: true, envelope: true, flags: true, size: true, bodyStructure: true, headers: TRUST_HEADERS };

class AccountWorker {
  constructor(manager, accountId) {
    this.manager = manager;
    this.accountId = accountId;
    this.client = null;
    this.status = 'idle';
    this.error = null;
    this.queue = Promise.resolve();
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.initialSyncDone = false;
  }

  get db() {
    return this.manager.db;
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.manager.emit('sync:status', { accountId: this.accountId, status, error });
  }

  /** Serialize all work on this account's single IMAP connection. */
  run(work) {
    const next = this.queue.then(() => this.manager.semaphore.use(async () => {
      await this.ensureConnected();
      return work(this.client);
    }));
    this.queue = next.catch(() => {});
    return next;
  }

  async ensureConnected() {
    if (this.stopped) throw new Error('Account sync is stopped.');
    if (this.client?.usable) return;
    const account = this.db.getAccount(this.accountId, { withSecrets: true });
    this.setStatus('connecting');
    const client = new ImapFlow(imapConfig(account));
    client.on('error', () => {});
    client.on('exists', (event) => {
      if (event.path?.toUpperCase() === 'INBOX' && event.count > event.prevCount) this.scheduleSync(['inbox']);
    });
    client.on('close', () => {
      if (this.client !== client) return;
      this.client = null;
      if (!this.stopped) this.scheduleReconnect();
    });
    try {
      await client.connect();
    } catch (error) {
      const message = error.authenticationFailed ? 'Authentication failed. Check the password or app password.' : (error.message || 'Connection failed.');
      this.setStatus('error', message);
      if (!error.authenticationFailed && !this.stopped) {
        clearTimeout(this.reconnectTimer);
        const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => this.syncNow().catch(() => {}), delay);
      }
      throw new Error(message);
    }
    this.client = client;
    this.reconnectAttempt = 0;
    await this.discoverFolders(client);
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt += 1;
    this.setStatus('offline', this.error);
    this.reconnectTimer = setTimeout(() => this.syncNow().catch(() => {}), delay);
  }

  scheduleSync(targets) {
    this.pendingTargets = new Set([...(this.pendingTargets || []), ...targets]);
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      const next = [...this.pendingTargets];
      this.pendingTargets = new Set();
      this.syncNow(next).catch(() => {});
    }, 400);
  }

  async discoverFolders(client) {
    const folders = await client.list();
    const keep = new Set();
    const roles = new Set();
    for (const folder of folders) {
      if (folder.flags?.has('\\Noselect') || folder.flags?.has('\\NonExistent')) continue;
      let role = folderRole(folder);
      // Only one folder per special role; extra matches are shown as normal folders.
      if (role !== 'custom' && roles.has(role)) role = 'custom';
      roles.add(role);
      keep.add(folder.path);
      this.db.upsertFolder(this.accountId, folder.path, role, folder.path.toUpperCase() === 'INBOX' ? 'Inbox' : folder.name);
    }
    if (!roles.has('inbox')) {
      keep.add('INBOX');
      this.db.upsertFolder(this.accountId, 'INBOX', 'inbox', 'Inbox');
    }
    this.db.pruneFolders(this.accountId, keep);
  }

  folder(role) {
    return this.db.listFolders(this.accountId).find((folder) => folder.role === role);
  }

  /** targets: folder roles ('inbox', 'sent', …) or folder ids. */
  syncNow(targets = ['inbox', 'sent']) {
    return this.run(async (client) => {
      this.setStatus('syncing');
      const account = this.db.getAccount(this.accountId);
      let added = [];
      const folders = this.db.listFolders(this.accountId);
      for (const target of targets) {
        const folder = folders.find((f) => (typeof target === 'number' ? f.id === target : f.role === target));
        if (folder) added = added.concat(await this.syncFolder(client, folder, account));
      }
      await this.prefetchBodies(client);
      await client.mailboxOpen('INBOX').catch(() => {});
      const wasInitial = !this.initialSyncDone;
      this.initialSyncDone = true;
      this.setStatus('idle');
      this.manager.emit('mail:changed', {
        accountId: this.accountId,
        newInbox: wasInitial ? [] : added.filter((m) => m.folderRole === 'inbox' && !m.read).map((m) => ({
          id: m.id, projectId: m.projectId, accountId: m.accountId, subject: m.subject, from: m.from, trust: m.trust, important: m.important,
        })),
      });
      return added.length;
    }).catch((error) => {
      if (this.status !== 'error') this.setStatus('error', error.message);
      throw error;
    });
  }

  summarize(item, folder, account) {
    const summary = summarizeFetched(item, account);
    const headers = item.headers?.toString('utf8') || '';
    return { ...summary, references: parseReferences(item.headers), trust: classifyTrust({ ...summary, folderRole: folder.role, headers, authServers: trustedAuthServers(account) }) };
  }

  async fetchInto(client, folder, account, uids) {
    const fetched = [];
    for (let i = 0; i < uids.length; i += 250) {
      for await (const item of client.fetch(uids.slice(i, i + 250).join(','), FETCH_QUERY, { uid: true })) fetched.push(this.summarize(item, folder, account));
    }
    return this.db.insertMessages(folder, fetched);
  }

  /** Bring in up to `count` messages older than the oldest one stored for this folder. */
  loadOlder(folderId, count = OLDER_BATCH) {
    return this.run(async (client) => {
      const folder = this.db.getFolder(folderId);
      if (!folder) return { added: 0, done: true };
      const account = this.db.getAccount(this.accountId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        this.db.setFolderServerTotal(folder.id, client.mailbox.exists);
        // The floor is where the continuous history ends; search results below it do not count.
        const floor = folder.floor_uid || this.db.oldestUid(folder.id);
        if (!floor || floor <= 1) {
          this.db.setFolderOlderDone(folder.id, Boolean(floor));
          return { added: 0, done: Boolean(floor) };
        }
        const older = ((await client.search({ uid: `1:${floor - 1}` }, { uid: true })) || []).filter((uid) => uid < floor).sort((a, b) => a - b);
        const batch = older.slice(-count);
        const local = new Set(this.db.localUids(folder.id));
        const missing = batch.filter((uid) => !local.has(uid));
        const added = missing.length ? await this.fetchInto(client, folder, account, missing) : [];
        const done = older.length <= count;
        this.db.setFolderFloor(folder.id, done ? 1 : batch[0]);
        this.db.setFolderOlderDone(folder.id, done);
        return { added: added.length, done };
      } finally {
        lock.release();
      }
    });
  }

  /** Ask the server (subject, people and body), bring in what is not stored yet; returns local ids of every hit. */
  searchFolder(folderId, query, limit = SEARCH_LIMIT) {
    return this.run(async (client) => {
      const folder = this.db.getFolder(folderId);
      if (!folder) return [];
      const account = this.db.getAccount(this.accountId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const criteria = { or: [{ subject: query }, { from: query }, { to: query }, { body: query }] };
        const uids = ((await client.search(criteria, { uid: true })) || []).sort((a, b) => b - a).slice(0, limit);
        const local = new Set(this.db.localUids(folder.id));
        const missing = uids.filter((uid) => !local.has(uid));
        if (missing.length) await this.fetchInto(client, folder, account, missing);
        return uids.map((uid) => `${folder.account_id}:${folder.id}:${uid}`);
      } finally {
        lock.release();
      }
    });
  }

  async syncFolder(client, folder, account) {
    const lock = await client.getMailboxLock(folder.path);
    try {
      const mailbox = client.mailbox;
      const uidValidity = String(mailbox.uidValidity);
      if (folder.uid_validity && folder.uid_validity !== uidValidity) {
        this.db.resetFolder(folder.id);
        folder = this.db.getFolder(folder.id);
      }
      if (!mailbox.exists) {
        this.db.reconcileFolder(folder, new Map(), 0);
        this.db.setFolderState(folder.id, { uidValidity, lastUid: folder.last_uid });
        return [];
      }

      this.db.setFolderServerTotal(folder.id, mailbox.exists);
      const fetched = [];
      const query = FETCH_QUERY;
      const summarize = (item) => this.summarize(item, folder, account);
      if (!folder.last_uid) {
        const start = Math.max(1, mailbox.exists - this.manager.initialWindow + 1);
        for await (const item of client.fetch(`${start}:*`, query)) fetched.push(summarize(item));
      } else {
        for await (const item of client.fetch(`${folder.last_uid + 1}:*`, query, { uid: true })) {
          if (item.uid > folder.last_uid) fetched.push(summarize(item));
        }
      }
      const added = this.db.insertMessages(folder, fetched);
      if (!folder.last_uid && fetched.length) this.db.setFolderFloor(folder.id, Math.min(...fetched.map((m) => m.uid)));
      const lastUid = Math.max(folder.last_uid, ...fetched.map((m) => m.uid));

      // Refresh read/flag state and remove messages deleted elsewhere, within a bounded window.
      const localUids = this.db.db.prepare('SELECT uid FROM messages WHERE folder_id = ? ORDER BY uid DESC LIMIT ?').all(folder.id, RECONCILE_WINDOW);
      if (localUids.length) {
        const minUid = localUids[localUids.length - 1].uid;
        const serverState = new Map();
        for await (const item of client.fetch(`${minUid}:*`, { uid: true, flags: true }, { uid: true })) {
          serverState.set(item.uid, { seen: item.flags?.has('\\Seen') || false, flagged: item.flags?.has('\\Flagged') || false });
        }
        this.db.reconcileFolder(folder, serverState, minUid);
      }
      this.db.setFolderState(folder.id, { uidValidity, lastUid });
      return added;
    } finally {
      lock.release();
    }
  }

  async prefetchBodies(client) {
    const pending = this.db.messagesToPrefetch(this.accountId, PREFETCH_BODIES);
    const byFolder = new Map();
    for (const message of pending) {
      if (!byFolder.has(message.folderId)) byFolder.set(message.folderId, []);
      byFolder.get(message.folderId).push(message);
    }
    for (const [folderId, messages] of byFolder) {
      const folder = this.db.getFolder(folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const uids = messages.map((m) => m.uid).join(',');
        const byUid = new Map(messages.map((m) => [m.uid, m]));
        for await (const item of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
          const message = byUid.get(item.uid);
          if (!message || !item.source) continue;
          const parsed = await parseRawMessage(item.source);
          this.db.setRaw(message.id, item.source, parsed.preview);
          this.db.refreshTrust(message.id, item.source);
          this.db.verifyTrustLater(message.id, item.source, verifiedDkimDomains);
        }
      } finally {
        lock.release();
      }
    }
  }

  fetchRaw(message) {
    return this.run(async (client) => {
      const folder = this.db.getFolder(message.folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const item = await client.fetchOne(String(message.uid), { source: true }, { uid: true });
        if (!item?.source) throw new Error('Message was not found on the server.');
        return item.source;
      } finally {
        lock.release();
      }
    });
  }

  setSeen(message, seen) {
    return this.run(async (client) => {
      const folder = this.db.getFolder(message.folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        if (seen) await client.messageFlagsAdd(String(message.uid), ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(String(message.uid), ['\\Seen'], { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  /** One IMAP command per folder, however many messages. */
  setSeenMany(folderId, uids, seen) {
    return this.run(async (client) => {
      const folder = this.db.getFolder(folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        const range = uids.join(',');
        if (seen) await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
        else await client.messageFlagsRemove(range, ['\\Seen'], { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  setFlagged(message, flagged) {
    return this.run(async (client) => {
      const folder = this.db.getFolder(message.folderId);
      const lock = await client.getMailboxLock(folder.path);
      try {
        if (flagged) await client.messageFlagsAdd(String(message.uid), ['\\Flagged'], { uid: true });
        else await client.messageFlagsRemove(String(message.uid), ['\\Flagged'], { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  moveToTrash(message) {
    return this.run(async (client) => {
      const folder = this.db.getFolder(message.folderId);
      const trash = this.folder('trash');
      const lock = await client.getMailboxLock(folder.path);
      try {
        if (trash && trash.id !== folder.id) await client.messageMove(String(message.uid), trash.path, { uid: true });
        else await client.messageDelete(String(message.uid), { uid: true });
      } finally {
        lock.release();
      }
      if (trash && trash.id !== folder.id) this.scheduleSync([trash.id]);
    });
  }

  /** Archive: Archive folder, else Gmail "All Mail", else create an "Archive" folder. */
  archive(message) {
    return this.run(async (client) => {
      const folder = this.db.getFolder(message.folderId);
      let target = this.folder('archive') || this.folder('all');
      if (!target) {
        await client.mailboxCreate('Archive').catch(() => {});
        await this.discoverFolders(client);
        target = this.folder('archive') || this.db.listFolders(this.accountId).find((f) => f.path === 'Archive');
      }
      if (!target || target.id === folder.id) return;
      const lock = await client.getMailboxLock(folder.path);
      try {
        await client.messageMove(String(message.uid), target.path, { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  moveTo(message, folderId) {
    return this.run(async (client) => {
      const folder = this.db.getFolder(message.folderId);
      const target = this.db.getFolder(folderId);
      if (!target || target.account_id !== this.accountId || target.id === folder.id) throw new Error('Choose another folder in the same account.');
      const lock = await client.getMailboxLock(folder.path);
      try {
        await client.messageMove(String(message.uid), target.path, { uid: true });
      } finally {
        lock.release();
      }
      this.scheduleSync([target.id]);
    });
  }

  appendSent(raw) {
    return this.run(async (client) => {
      const sent = this.folder('sent');
      if (!sent) return false;
      await client.append(sent.path, raw, ['\\Seen']);
      return true;
    });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.syncTimer);
    const client = this.client;
    this.client = null;
    if (client) await client.logout().catch(() => client.close());
  }
}

class SyncManager {
  constructor({ db, emit = () => {}, initialWindow = INITIAL_WINDOW }) {
    this.initialWindow = initialWindow;
    this.db = db;
    this.emit = emit;
    this.workers = new Map();
    this.semaphore = new Semaphore(MAX_PARALLEL_SYNCS);
    this.timer = null;
  }

  worker(accountId) {
    if (!this.workers.has(accountId)) this.workers.set(accountId, new AccountWorker(this, accountId));
    return this.workers.get(accountId);
  }

  start() {
    for (const account of this.db.listAccounts()) this.worker(account.id).syncNow().catch(() => {});
    this.timer = setInterval(() => this.syncAll(), PERIODIC_SYNC_MS);
  }

  syncAll() {
    return Promise.allSettled(this.db.listAccounts().map((account) => this.worker(account.id).syncNow()));
  }

  statuses() {
    return Object.fromEntries([...this.workers].map(([id, worker]) => [id, { status: worker.status, error: worker.error }]));
  }

  async removeAccount(accountId) {
    const worker = this.workers.get(accountId);
    this.workers.delete(accountId);
    if (worker) await worker.stop();
  }

  async stop() {
    clearInterval(this.timer);
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.stop()));
    this.workers.clear();
  }
}

module.exports = { SyncManager, folderRole };
