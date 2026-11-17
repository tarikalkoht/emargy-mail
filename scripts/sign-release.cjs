/**
 * Signs a release so installed copies accept it as an update.
 *   node scripts/sign-release.cjs [release-dir] [win|linux|mac]   (default: win)
 * Writes the system's manifest (emargy-update.json, emargy-update-linux.json or
 * emargy-update-mac.json) and its .sig next to the installer. The private key lives only on the
 * maintainer's computer (%USERPROFILE%\.emargy-release) and is never committed.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { signManifest, verifyManifest, MANIFESTS } = require('../electron/updater.cjs');
const { version } = require('../package.json');

const TARGETS = {
  win: { platform: 'win32', file: `Emargy-Mail-Setup-${version}.exe` },
  linux: { platform: 'linux', file: `Emargy-Mail-${version}.AppImage` },
  mac: { platform: 'darwin', file: `Emargy-Mail-${version}-universal.dmg` },
};

const dir = path.resolve(process.argv[2] || 'release-next');
const target = TARGETS[process.argv[3] || 'win'];
if (!target) throw new Error(`Unknown target "${process.argv[3]}". Use win, linux or mac.`);
const keyFile = process.env.EMARGY_SIGNING_KEY || path.join(os.homedir(), '.emargy-release', 'update-signing-key.pem');
const installer = fs.readFileSync(path.join(dir, target.file));
const manifest = {
  version,
  file: target.file,
  size: installer.length,
  sha256: crypto.createHash('sha256').update(installer).digest('hex'),
  date: new Date().toISOString(),
};
const { text, signature } = signManifest(manifest, fs.readFileSync(keyFile, 'utf8'));
verifyManifest(text, signature, undefined, target.platform); // must verify with the public key built into the app
const manifestName = MANIFESTS[target.platform];
fs.writeFileSync(path.join(dir, manifestName), text);
fs.writeFileSync(path.join(dir, `${manifestName}.sig`), signature);
console.log(`Signed ${target.file} as ${manifestName} (${manifest.size} bytes, sha256 ${manifest.sha256.slice(0, 16)}...)`);
