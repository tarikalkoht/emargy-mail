/**
 * How fast are the everyday views with a large mailbox?
 *   node scripts/bench-mailbox.cjs [messages=100000]
 * Builds a throwaway database in a temp folder with synthetic headers (nothing real),
 * then times what the app does on every click and every new message.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vault } = require('../electron/vault.cjs');
const { Database } = require('../electron/db.cjs');

const COUNT = Number(process.argv[2]) || 100_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emargy-bench-'));
const vault = new Vault({ keyFile: path.join(dir, 'vault.key'), protect: (k) => Buffer.from(k), unprotect: (d) => Buffer.from(d) });
const db = new Database({ file: path.join(dir, 'bench.db'), vault });

const projects = [0, 1, 2, 3].map((i) => db.createProject({ name: `Project ${i}`, color: '#15b886' }));
const accounts = Array.from({ length: 13 }, (_, i) => db.createAccount({ projectId: projects[i % 4], email: `a${i}@example.test`, imapHost: 'x' }));
const roles = ['inbox', 'inbox', 'inbox', 'inbox', 'sent', 'archive', 'trash', 'junk'];
const folders = accounts.flatMap((accountId) => ['inbox', 'sent', 'archive', 'trash', 'junk'].map((role) => ({ ...db.upsertFolder(accountId, role.toUpperCase(), role, role), accountId })));
const words = ['offer', 'invoice', 'meeting', 'مشروع', 'عرض', 'فاتورة', 'contract', 'report', 'hello', 'urgent', 'أسامة', 'weekly'];
const now = Date.now();
for (let i = 0; i < COUNT; i += 1) {
  const accountId = accounts[i % accounts.length];
  const role = roles[i % roles.length];
  const folder = folders.find((f) => f.accountId === accountId && f.role === role);
  const subject = `${words[i % words.length]} ${words[(i * 7) % words.length]} #${i}`;
  const header = {
    id: `m${i}`, accountId, projectId: projects[accounts.indexOf(accountId) % 4], folderId: folder.id, folderRole: role, uid: i,
    date: new Date(now - i * 60_000).toISOString(), dateValue: now - i * 60_000, read: i % 9 !== 0, flagged: i % 50 === 0,
    important: false, hasAttachments: i % 7 === 0, size: 1000, cached: false, subject, from: `Sender ${i % 3000} <s${i % 3000}@x.test>`,
    fromAddress: `s${i % 3000}@x.test`, to: 'a@example.test', preview: 'Lorem ipsum dolor sit amet', threadKey: `t${Math.floor(i / 3)}`,
    messageId: `<m${i}@x>`, trust: '', category: 'primary',
  };
  header.search = `${subject} ${header.from} ${header.preview}`.toLowerCase();
  db.headers.set(header.id, header);
}

function time(label, work, runs = 5) {
  work();
  const start = process.hrtime.bigint();
  for (let i = 0; i < runs; i += 1) work();
  const ms = Number(process.hrtime.bigint() - start) / 1e6 / runs;
  console.log(`${label.padEnd(44)} ${ms.toFixed(1).padStart(7)} ms`);
  return ms;
}

console.log(`${COUNT.toLocaleString()} messages, ${accounts.length} accounts\n`);
const results = {
  sort: time('sort all headers (after each sync change)', () => db.sortHeaders()),
  unified: time('open "All inboxes"', () => db.listMessages({ folderRole: 'inbox', limit: 150 })),
  project: time('open one project inbox', () => db.listMessages({ projectId: projects[1], folderRole: 'inbox', limit: 150 })),
  account: time('open one account inbox', () => db.listMessages({ accountId: accounts[3], folderRole: 'inbox', limit: 150 })),
  unread: time('unread filter', () => db.listMessages({ folderRole: 'inbox', filter: 'unread', limit: 150 })),
  search: time('search "عرض"', () => db.listMessages({ query: 'عرض', limit: 150 })),
  counts: time('unread counts (every state refresh)', () => db.unreadCounts()),
  folders: time('folder list with counts', () => db.listAllFolders()),
};
db.close();
fs.rmSync(dir, { recursive: true, force: true });
module.exports = results;
