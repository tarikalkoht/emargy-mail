import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Updater, verifyManifest, signManifest, compareVersions } = require('../electron/updater.cjs');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PRIVATE = privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUBLIC = publicKey.export({ type: 'spki', format: 'pem' });
const otherKey = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
const installer = Buffer.from('MZ fake installer for tests '.repeat(5000));
const manifestFor = (data, version = '9.9.9') => ({
  version, file: `Emargy-Mail-Setup-${version}.exe`, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'),
});

let server;
let files = {};
let base;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = files[decodeURIComponent(req.url.slice(1))];
    if (body === undefined) { res.writeHead(404); return res.end(); }
    res.writeHead(200);
    return res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

function publish(manifest, data, { signWith = PRIVATE, tamper = false } = {}) {
  const { text, signature } = signManifest(manifest, signWith);
  files = {
    'emargy-update.json': tamper ? text.replace(manifest.sha256, '0'.repeat(64)) : text,
    'emargy-update.json.sig': signature,
    [manifest.file]: data,
  };
}

const updater = (extra = {}) => new Updater({ currentVersion: '0.5.0', isPackaged: false, portable: false, baseUrl: base, publicKey: PUBLIC, ...extra });

describe('signed updates', () => {
  it('compares versions and refuses downgrades', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v0.5.0', '0.5.0')).toBe(0);
    expect(compareVersions('0.4.9', '0.5.0')).toBe(-1);
  });

  it('accepts only manifests signed by the project key', () => {
    const { text, signature } = signManifest(manifestFor(installer), PRIVATE);
    expect(verifyManifest(text, signature, PUBLIC).version).toBe('9.9.9');
    expect(() => verifyManifest(text.replace('9.9.9', '9.9.8'), signature, PUBLIC)).toThrow(/not valid/);
    expect(() => verifyManifest(text, signManifest(manifestFor(installer), otherKey()).signature, PUBLIC)).toThrow(/not valid/);
    expect(() => verifyManifest(text, '', PUBLIC)).toThrow(/missing/);
  });

  it('downloads, verifies and becomes ready for a newer signed release', async () => {
    publish(manifestFor(installer), installer);
    const u = updater();
    expect(await u.check()).toMatchObject({ state: 'ready', version: '9.9.9' });
    expect(fs.readFileSync(u.installer).equals(installer)).toBe(true);
  });

  it('refuses a swapped installer, a forged or edited manifest, and older versions', async () => {
    publish(manifestFor(installer), Buffer.concat([installer.subarray(0, -1), Buffer.from('X')]));
    expect(await updater().check()).toMatchObject({ state: 'error', error: expect.stringMatching(/does not match/) });

    publish(manifestFor(installer), installer, { signWith: otherKey() });
    expect(await updater().check()).toMatchObject({ state: 'error', error: expect.stringMatching(/signature is not valid/) });

    publish(manifestFor(installer), installer, { tamper: true });
    expect((await updater().check()).state).toBe('error');

    publish(manifestFor(installer, '0.4.0'), installer);
    expect((await updater().check()).state).toBe('current');
  });

  it('only points portable copies to the download page', async () => {
    publish(manifestFor(installer), installer);
    expect(await updater({ portable: true }).check()).toMatchObject({ state: 'available', version: '9.9.9' });
  });

  it('never checks or installs in the Microsoft Store copy', async () => {
    publish(manifestFor(installer), installer);
    const u = updater({ store: true });
    expect(await u.check()).toMatchObject({ state: 'store' });
    expect(() => u.install()).toThrow();
  });

  it('will not run an installer that changed after it was verified', async () => {
    publish(manifestFor(installer), installer);
    const u = updater();
    await u.check();
    fs.appendFileSync(u.installer, 'evil');
    expect(() => u.install()).toThrow(/changed on disk/);
    fs.rmSync(path.dirname(u.installer), { recursive: true, force: true });
  });
});
