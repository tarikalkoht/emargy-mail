/**
 * Automatic updates from the project's GitHub Releases, protected against tampering.
 *
 * Every release carries `emargy-update.json` (version, installer name, size, SHA-256) and
 * `emargy-update.json.sig`, an Ed25519 signature made with the maintainer's private key,
 * which never leaves the maintainer's computer. The app only installs an update when:
 *   1. the manifest signature matches the public key built into the app,
 *   2. the version is newer than the running one (no downgrades),
 *   3. the downloaded installer has exactly the signed size and SHA-256.
 * A hacked GitHub account, a fake release or a swapped file is therefore refused.
 * Nothing is installed without the reader pressing "Restart and update".
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPOSITORY = 'tarikalkoht/emargy-mail';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApg2DbB4DS+yB4eRgUJqojwpkCY+Ga2SxPXprUym8wvk=
-----END PUBLIC KEY-----`;
const MANIFEST = 'emargy-update.json';
const MAX_INSTALLER = 400 * 1024 * 1024;
const CHECK_EVERY = 6 * 60 * 60 * 1000;

function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** Returns the parsed manifest only if it was signed by the maintainer's key. */
function verifyManifest(manifestText, signatureBase64, publicKey = PUBLIC_KEY) {
  const signature = Buffer.from(String(signatureBase64 || '').trim(), 'base64');
  if (signature.length !== 64) throw new Error('Update signature is missing or malformed.');
  const ok = crypto.verify(null, Buffer.from(manifestText, 'utf8'), crypto.createPublicKey(publicKey), signature);
  if (!ok) throw new Error('Update signature is not valid. The update was refused.');
  const manifest = JSON.parse(manifestText);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^Emargy-Mail-Setup-[\d.]+\.exe$/.test(manifest.file)
    || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !(manifest.size > 0 && manifest.size < MAX_INSTALLER)) {
    throw new Error('Update manifest is not valid.');
  }
  return manifest;
}

function signManifest(manifest, privateKeyPem) {
  const text = JSON.stringify(manifest, null, 2);
  const signature = crypto.sign(null, Buffer.from(text, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { text, signature };
}

async function fetchChecked(url, { json = false, text = false } = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Emargy-Mail-Updater', Accept: json ? 'application/vnd.github+json' : '*/*' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`Update server answered ${response.status}.`);
  if (json) return response.json();
  if (text) return response.text();
  return response;
}

async function downloadVerified(url, manifest, destination) {
  const response = await fetchChecked(url);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(destination, { mode: 0o600 });
  let size = 0;
  try {
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > manifest.size) throw new Error('Update file is larger than signed.');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('Downloaded update does not match its signature. It was deleted.');
    return destination;
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
}

class Updater {
  constructor({ currentVersion, isPackaged, portable, baseUrl = process.env.EMARGY_UPDATE_URL, publicKey = PUBLIC_KEY, emit = () => {}, onQuit = () => {} }) {
    this.publicKey = publicKey;
    this.currentVersion = currentVersion;
    this.enabled = isPackaged || Boolean(baseUrl);
    this.portable = portable;
    this.baseUrl = baseUrl;
    this.emit = emit;
    this.onQuit = onQuit;
    this.status = { state: 'idle', currentVersion };
    this.timer = null;
  }

  set(status) {
    this.status = { currentVersion: this.currentVersion, ...status };
    this.emit(this.status);
    return this.status;
  }

  start(delay = 20_000) {
    if (!this.enabled) return;
    this.stop();
    this.firstCheck = setTimeout(() => this.check().catch(() => {}), delay);
    this.timer = setInterval(() => this.check().catch(() => {}), CHECK_EVERY);
  }

  stop() { clearInterval(this.timer); clearTimeout(this.firstCheck); }

  async releaseAssets() {
    if (this.baseUrl) {
      return { page: this.baseUrl, asset: (name) => `${this.baseUrl.replace(/\/$/, '')}/${name}` };
    }
    const release = await fetchChecked(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, { json: true });
    const urls = new Map((release.assets || []).map((a) => [a.name, a.browser_download_url]));
    return { page: release.html_url, asset: (name) => urls.get(name) };
  }

  async check() {
    if (!this.enabled || ['downloading', 'ready'].includes(this.status.state)) return this.status;
    this.set({ state: 'checking' });
    try {
      const { page, asset } = await this.releaseAssets();
      const manifestUrl = asset(MANIFEST);
      const signatureUrl = asset(`${MANIFEST}.sig`);
      if (!manifestUrl || !signatureUrl) return this.set({ state: 'current' });
      const manifest = verifyManifest(await fetchChecked(manifestUrl, { text: true }), await fetchChecked(signatureUrl, { text: true }), this.publicKey);
      if (compareVersions(manifest.version, this.currentVersion) <= 0) return this.set({ state: 'current' });
      if (this.portable) return this.set({ state: 'available', version: manifest.version, page });
      const installerUrl = asset(manifest.file);
      if (!installerUrl) throw new Error('Update file is missing from the release.');
      this.set({ state: 'downloading', version: manifest.version });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emargy-update-'));
      this.manifest = manifest;
      this.installer = await downloadVerified(installerUrl, manifest, path.join(dir, manifest.file));
      return this.set({ state: 'ready', version: manifest.version });
    } catch (error) {
      return this.set({ state: 'error', error: error.message });
    }
  }

  install() {
    if (this.status.state !== 'ready' || !this.installer || !fs.existsSync(this.installer)) throw new Error('No verified update is ready.');
    // Check the file once more right before running it.
    if (crypto.createHash('sha256').update(fs.readFileSync(this.installer)).digest('hex') !== this.manifest.sha256) {
      this.set({ state: 'error', error: 'The downloaded update was changed on disk. It was refused.' });
      throw new Error('The downloaded update was changed on disk.');
    }
    // Silent install over the current one, then start the new version.
    spawn(this.installer, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    this.onQuit();
    return { ok: true };
  }
}

module.exports = { Updater, verifyManifest, signManifest, compareVersions, downloadVerified, MANIFEST, PUBLIC_KEY };
