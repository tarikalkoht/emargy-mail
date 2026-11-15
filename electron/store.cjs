const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, safeStorage } = require('electron');

const EMPTY_STATE = {
  version: 1,
  language: 'en',
  projects: [],
  accounts: [],
  messages: [],
  drafts: [],
  audit: [],
};

class Store {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'emargy-mail.json');
    this.state = this.read();
  }

  read() {
    try {
      return { ...EMPTY_STATE, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  save() {
    const temporary = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
  }

  publicState() {
    return {
      ...this.state,
      accounts: this.state.accounts.map(({ encryptedPassword, ...account }) => account),
    };
  }

  id() {
    return crypto.randomUUID();
  }

  encrypt(secret) {
    if (!secret) return '';
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable on this device.');
    }
    return safeStorage.encryptString(secret).toString('base64');
  }

  decrypt(secret) {
    if (!secret) return '';
    return safeStorage.decryptString(Buffer.from(secret, 'base64'));
  }

  audit(action, details = {}) {
    this.state.audit.unshift({ id: this.id(), action, details, at: new Date().toISOString() });
    this.state.audit = this.state.audit.slice(0, 500);
  }
}

module.exports = { Store };

