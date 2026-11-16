import { describe, expect, it } from 'vitest';

const { classifyTrust } = require('../electron/core.cjs');
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
    expect(classifyTrust({ from: 'Bank <x@bank.test>', fromAddress: 'x@bank.test', headers: headers(['Authentication-Results: mx.test; dmarc=fail header.from=bank.test']) })).toBe('suspicious');
    expect(classifyTrust({ from: 'MetaMask Support <help@random-host.test>', fromAddress: 'help@random-host.test' })).toBe('suspicious');
    expect(classifyTrust({ from: '"info@emargy.com" <billing@evil.test>', fromAddress: 'billing@evil.test' })).toBe('suspicious');
  });

  it('marks DKIM-signed mail from the sender’s own domain as verified', () => {
    const results = 'Authentication-Results: paloma.test; dkim=pass header.d=acme.test header.s=k1; spf=pass smtp.mailfrom=acme.test; dmarc=pass';
    expect(classifyTrust({ from: 'Acme <ceo@acme.test>', fromAddress: 'ceo@acme.test', headers: headers([results]) })).toBe('verified');
    expect(classifyTrust({ from: 'Acme <ceo@mail.acme.test>', fromAddress: 'ceo@mail.acme.test', headers: headers([results]) })).toBe('verified');
    // A signature from another domain proves nothing about the sender.
    expect(classifyTrust({ from: 'Acme <ceo@other.test>', fromAddress: 'ceo@other.test', headers: headers([results]) })).toBe('');
  });

  it('trusts only the topmost Authentication-Results (added by the receiving server)', () => {
    const forged = headers([
      'Authentication-Results: paloma.test; dkim=fail; dmarc=fail header.from=acme.test',
      'Authentication-Results: fake; dkim=pass header.d=acme.test; dmarc=pass',
    ]);
    expect(classifyTrust({ from: 'ceo@acme.test', fromAddress: 'ceo@acme.test', headers: forged })).toBe('suspicious');
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
