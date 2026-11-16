/**
 * Local DKIM verification: the signature is checked by this app against the public key the
 * signing domain publishes in DNS, so a "verified sender" badge cannot be faked by writing
 * an Authentication-Results header into the message.
 */
const { dkimVerify } = require('mailauth');

const TIMEOUT = 8000;

/** Domains whose DKIM signature on this raw message verifies. Empty on any doubt. */
async function verifiedDkimDomains(raw, { resolver } = {}) {
  const work = dkimVerify(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8'), resolver ? { resolver } : {});
  const timeout = new Promise((resolve) => { setTimeout(() => resolve(null), TIMEOUT).unref?.(); });
  const result = await Promise.race([work, timeout]).catch(() => null);
  return (result?.results || [])
    .filter((r) => r?.status?.result === 'pass' && r.signingDomain)
    .map((r) => String(r.signingDomain).toLowerCase());
}

module.exports = { verifiedDkimDomains };
