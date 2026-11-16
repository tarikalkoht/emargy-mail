/**
 * Signs a release so installed copies accept it as an update.
 *   node scripts/sign-release.cjs [release-dir]
 * Writes emargy-update.json and emargy-update.json.sig next to the installer. The private key
 * lives only on the maintainer's computer (%USERPROFILE%\.emargy-release) and is never committed.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { signManifest, verifyManifest, MANIFEST } = require('../electron/updater.cjs');
const { version } = require('../package.json');

const dir = path.resolve(process.argv[2] || 'release-next');
const keyFile = process.env.EMARGY_SIGNING_KEY || path.join(os.homedir(), '.emargy-release', 'update-signing-key.pem');
const file = `Emargy-Mail-Setup-${version}.exe`;
const installer = fs.readFileSync(path.join(dir, file));
const manifest = {
  version,
  file,
  size: installer.length,
  sha256: crypto.createHash('sha256').update(installer).digest('hex'),
  date: new Date().toISOString(),
};
const { text, signature } = signManifest(manifest, fs.readFileSync(keyFile, 'utf8'));
verifyManifest(text, signature); // must verify with the public key built into the app
fs.writeFileSync(path.join(dir, MANIFEST), text);
fs.writeFileSync(path.join(dir, `${MANIFEST}.sig`), signature);
console.log(`Signed ${file} (${manifest.size} bytes, sha256 ${manifest.sha256.slice(0, 16)}...)`);
