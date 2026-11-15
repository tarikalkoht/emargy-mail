const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Local encryption vault.
 *
 * A random 256-bit data key encrypts every sensitive value (message headers,
 * bodies, drafts, outbox, passwords) with AES-256-GCM. The data key itself is
 * stored on disk only after being wrapped by the operating system
 * (Windows DPAPI through Electron safeStorage), so the database is unreadable
 * if it is copied to another machine or user account.
 */
class Vault {
  constructor({ keyFile, protect, unprotect }) {
    if (typeof protect !== 'function' || typeof unprotect !== 'function') {
      throw new Error('Vault requires OS key protection functions.');
    }
    this.keyFile = keyFile;
    this.key = this.loadOrCreateKey(protect, unprotect);
  }

  loadOrCreateKey(protect, unprotect) {
    if (fs.existsSync(this.keyFile)) {
      const key = unprotect(fs.readFileSync(this.keyFile));
      if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('The local encryption key is invalid.');
      return key;
    }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    const temporary = `${this.keyFile}.tmp`;
    fs.writeFileSync(temporary, protect(key), { mode: 0o600 });
    fs.renameSync(temporary, this.keyFile);
    return key;
  }

  encrypt(value) {
    const plain = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), encrypted]);
  }

  decrypt(blob) {
    const data = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    if (data.length < 1 + IV_LENGTH + TAG_LENGTH || data[0] !== VERSION) {
      throw new Error('Encrypted value has an unknown format.');
    }
    const iv = data.subarray(1, 1 + IV_LENGTH);
    const tag = data.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(1 + IV_LENGTH + TAG_LENGTH)), decipher.final()]);
  }

  encryptJson(value) {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson(blob) {
    return JSON.parse(this.decrypt(blob).toString('utf8'));
  }

  decryptText(blob) {
    return this.decrypt(blob).toString('utf8');
  }

  /** Keyed hash for lookups (e.g. trusted image senders) without storing the value. */
  fingerprint(value) {
    return crypto.createHmac('sha256', this.key).update(String(value).toLowerCase().trim()).digest('hex');
  }
}

module.exports = { Vault };
