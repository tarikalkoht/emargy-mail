const fs = require('node:fs');

function wipeFile(file) {
  try {
    const size = fs.statSync(file).size;
    fs.writeFileSync(file, Buffer.alloc(size));
  } catch {
    // Best effort; the file is removed below either way.
  }
  fs.rmSync(file, { force: true });
}

/**
 * Import projects, accounts and drafts from the first prototype's plaintext JSON
 * file, then wipe that file because it contained message content in clear text.
 * Messages are not imported: they are re-synchronized into the encrypted database.
 */
function migrateLegacyStore({ db, legacyFile, decryptLegacySecret }) {
  if (!fs.existsSync(legacyFile)) return { migrated: false };
  const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  const known = new Set(db.listProjects().map((project) => project.id));
  let accounts = 0;
  const importedAccounts = new Set(db.listAccounts().map((account) => account.id));
  db.transaction(() => {
    if (legacy.language) db.setSetting('language', legacy.language === 'ar' ? 'ar' : 'en');
    for (const project of legacy.projects || []) {
      if (known.has(project.id)) continue;
      db.createProject({ name: project.name, color: project.color }, project.id, Date.parse(project.createdAt) || Date.now());
      known.add(project.id);
    }
    for (const account of legacy.accounts || []) {
      if (!known.has(account.projectId) || importedAccounts.has(account.id)) continue;
      const { id, encryptedPassword, createdAt, lastSyncAt, lastError, ...rest } = account;
      db.createAccount({ ...rest, password: decryptLegacySecret(encryptedPassword) }, id, Date.parse(createdAt) || Date.now());
      importedAccounts.add(id);
      accounts += 1;
    }
    for (const draft of legacy.drafts || []) {
      if (draft.status !== 'draft' || !importedAccounts.has(draft.accountId)) continue;
      db.saveDraft({ id: draft.id, accountId: draft.accountId, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body });
    }
  });
  db.audit('storage.migrated_from_prototype', { accounts });
  wipeFile(legacyFile);
  wipeFile(`${legacyFile}.tmp`);
  return { migrated: true, accounts };
}

module.exports = { migrateLegacyStore, wipeFile };
