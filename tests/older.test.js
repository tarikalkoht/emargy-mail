import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Vault } = require('../electron/vault.cjs');
const { Database } = require('../electron/db.cjs');
const { SyncManager } = require('../electron/sync.cjs');
const { Outbox } = require('../electron/outbox.cjs');
const { createApi } = require('../electron/api.cjs');
const { startMailServers } = require('./helpers/mailServers.cjs');

const protect = (key) => Buffer.from(key.map((byte) => byte ^ 0x5a));
const unprotect = (data) => Buffer.from(data.map((byte) => byte ^ 0x5a));

// A mailbox bigger than the first sync window: 12 messages, only the newest 5 are synced at first.
const TOTAL = 12;
const seed = Array.from({ length: TOTAL }, (_, i) => ({
  from: `Sender ${i + 1} <s${i + 1}@acme.test>`,
  to: 'tester@emargy.test',
  subject: `Message number ${i + 1}`,
  body: i === 1 ? 'The tender reference is ZEBRA-4471 for the new tower.' : `Plain body ${i + 1}`,
  id: `old-${i + 1}`,
}));

describe('older mail and server search', () => {
  let dir;
  let servers;
  let db;
  let sync;
  let outbox;
  let api;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emargy-older-'));
    servers = await startMailServers({ seed });
    const vault = new Vault({ keyFile: path.join(dir, 'vault.key'), protect, unprotect });
    db = new Database({ file: path.join(dir, 'emargy.db'), vault });
    sync = new SyncManager({ db, initialWindow: 5 });
    outbox = new Outbox({ db, sync });
    api = createApi({ db, sync, outbox });
    db.createProject({ name: 'Test', color: '#017b66' });
    await api.addAccount({
      projectId: api.state().projects[0].id, provider: 'custom', displayName: 'Tester', email: servers.user, password: servers.password,
      imapHost: '127.0.0.1', imapPort: servers.imapPort, imapSecure: false, smtpHost: '127.0.0.1', smtpPort: servers.smtpPort, smtpSecure: false,
    });
    await api.syncAccount(api.state().accounts[0].id);
  });

  afterAll(async () => {
    outbox?.stop();
    await sync?.stop();
    db?.close();
    await servers?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('first syncs only the newest messages and knows more exist', () => {
    expect(api.listMessages({ folderRole: 'inbox' }).total).toBe(5);
    const inbox = api.state().folders.find((f) => f.role === 'inbox');
    expect(inbox).toMatchObject({ serverTotal: TOTAL, olderDone: false });
  });

  it('finds a message by words in its body on the server, even when it was never synced', async () => {
    expect(api.listMessages({ query: 'ZEBRA-4471' }).total).toBe(0);
    const result = await api.searchServer({ query: 'ZEBRA-4471' });
    expect(result.found).toBe(1);
    const hits = api.listMessages({ query: 'ZEBRA-4471' });
    expect(hits.total).toBe(1);
    expect(hits.messages[0].subject).toBe('Message number 2');
  });

  it('loads older mail in batches until the whole folder is here', async () => {
    const inbox = api.state().folders.find((f) => f.role === 'inbox');
    const worker = sync.worker(inbox.accountId);
    // Small batches: 5 synced + 1 found by search, then 3 older at a time (the search hit is not counted twice).
    expect(await worker.loadOlder(inbox.id, 3)).toMatchObject({ done: false });
    expect(api.listMessages({ folderRole: 'inbox' }).total).toBe(9);
    expect(await worker.loadOlder(inbox.id, 3)).toMatchObject({ done: false });
    expect(api.listMessages({ folderRole: 'inbox' }).total).toBe(11);
    const result = await api.loadOlder({ folderRole: 'inbox' });
    expect(result.done).toBe(true);
    expect(api.listMessages({ folderRole: 'inbox' }).total).toBe(TOTAL);
    expect(api.state().folders.find((f) => f.role === 'inbox').olderDone).toBe(true);
    // Nothing left: a second call does nothing.
    expect((await api.loadOlder({ folderRole: 'inbox' })).added).toBe(0);
  });
});
