import { describe, expect, it } from 'vitest';

const crypto = require('node:crypto');
const { classifyTrust, trustedAuthServers } = require('../electron/core.cjs');
const { parseVerdicts, describe: describeBatch } = require('../electron/importance.cjs');

const headers = (lines) => lines.join('\r\n');

describe('spam and trust verdicts', () => {
  it('recognises the server spam filter', () => {
    expect(classifyTrust({ subject: '***SPAM*** Re: Credible Business Partnership' })).toBe('spam');
    expect(classifyTrust({ subject: 'Hello', headers: headers(['X-Spam-Flag: YES']) })).toBe('spam');
    expect(classifyTrust({ subject: 'Hello', headers: headers(['X-Spam-Status: Yes, score=7.1']) })).toBe('spam');
    expect(classifyTrust({ subject: 'Hello', headers: headers(['X-Spam-Status: No, score=0.1']) })).toBe('');
    expect(classifyTrust({ subject: 'Hello', folderRole: 'junk' })).toBe('spam');
  });

  it('marks failed authentication and brand impersonation as suspicious', () => {
    const own = ['paloma.hostns.test', 'hostns.test'];
    expect(classifyTrust({ from: 'Bank <x@bank.test>', fromAddress: 'x@bank.test', authServers: own, headers: headers(['Authentication-Results: paloma.hostns.test; dmarc=fail header.from=bank.test']) })).toBe('suspicious');
    expect(classifyTrust({ from: 'MetaMask Support <help@random-host.test>', fromAddress: 'help@random-host.test' })).toBe('suspicious');
    expect(classifyTrust({ from: '"info@emargy.com" <billing@evil.test>', fromAddress: 'billing@evil.test' })).toBe('suspicious');
  });

  it('marks mail as verified only from a DKIM signature the app checked itself', () => {
    expect(classifyTrust({ from: 'Acme <ceo@acme.test>', fromAddress: 'ceo@acme.test', dkimDomains: ['acme.test'] })).toBe('verified');
    expect(classifyTrust({ from: 'Acme <ceo@mail.acme.test>', fromAddress: 'ceo@mail.acme.test', dkimDomains: ['acme.test'] })).toBe('verified');
    // A signature from another domain proves nothing about the sender.
    expect(classifyTrust({ from: 'Acme <ceo@other.test>', fromAddress: 'ceo@other.test', dkimDomains: ['acme.test'] })).toBe('');
  });

  it('never trusts an Authentication-Results header written by the sender', () => {
    const forgedPass = headers(['Authentication-Results: paloma.hostns.test; dkim=pass header.d=acme.test; spf=pass; dmarc=pass']);
    // Even with the reader's own server name in it, a header can only cast doubt, never verify.
    expect(classifyTrust({ from: 'ceo@acme.test', fromAddress: 'ceo@acme.test', headers: forgedPass, authServers: ['paloma.hostns.test'] })).toBe('');
    // A failure reported by some other server is ignored (it could be forged to discredit a sender).
    const otherFail = headers(['Authentication-Results: fake.example; dmarc=fail header.from=acme.test']);
    expect(classifyTrust({ from: 'ceo@acme.test', fromAddress: 'ceo@acme.test', headers: otherFail, authServers: ['paloma.hostns.test'] })).toBe('');
  });

  it('knows which servers speak for an account', () => {
    expect(trustedAuthServers({ imapHost: 'paloma.hostns.io' })).toEqual(['paloma.hostns.io', 'hostns.io']);
    expect(trustedAuthServers({ imapHost: 'imap.gmail.com' })).toContain('google.com');
    expect(trustedAuthServers({ imapHost: '127.0.0.1' })).toEqual([]);
  });

  it('verifies a real DKIM signature locally and rejects a tampered message', async () => {
    const { dkimSign } = require('mailauth');
    const { verifiedDkimDomains } = require('../electron/dkim.cjs');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const message = 'From: CEO <ceo@acme.test>\r\nTo: me@emargy.test\r\nSubject: Contract\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\n\r\nPlease sign the contract.\r\n';
    const signed = await dkimSign(message, { signatureData: [{ signingDomain: 'acme.test', selector: 'k1', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }) }] });
    const raw = signed.signatures + message;
    const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const resolver = async (name, type) => {
      if (type === 'TXT' && name === 'k1._domainkey.acme.test') return [[`v=DKIM1; k=rsa; p=${key}`]];
      const error = new Error('not found');
      error.code = 'ENOTFOUND';
      throw error;
    };
    expect(await verifiedDkimDomains(raw, { resolver })).toEqual(['acme.test']);
    expect(await verifiedDkimDomains(raw.replace('Please sign', 'Please pay'), { resolver })).toEqual([]);
  });
});

describe('important mail triage', () => {
  it('keeps only answers for ids that were asked, with known categories', () => {
    const answer = 'Sure:\n[{"id":"m1","important":true,"category":"government","reason":"Ministry asks for documents"},'
      + '{"id":"m2","important":"yes","category":"x"},{"id":"m9","important":true},{"id":"m1","important":false}]';
    const verdicts = parseVerdicts(answer, ['m1', 'm2']);
    expect(verdicts.get('m1')).toEqual({ important: true, category: 'government', reason: 'Ministry asks for documents' });
    expect(verdicts.get('m2')).toEqual({ important: false, category: 'other', reason: '' });
    expect(verdicts.has('m9')).toBe(false);
    expect(() => parseVerdicts('no json here', ['m1'])).toThrow(/expected format/);
  });

  it('sends only sender, subject and a short preview, with neutral ids', () => {
    const text = describeBatch([{ id: 'acct:12:345', from: 'Gov <a@gov.test>', subject: 'Tender', preview: 'x'.repeat(1000) }]);
    expect(text).toContain('id: m1');
    expect(text).not.toContain('acct:12:345');
    expect(text.length).toBeLessThan(400);
  });
});
