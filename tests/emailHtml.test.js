// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { prepareEmailHtml, printableEmailHtml } from '../src/emailHtml.js';

const tracker = '<p>Hi</p><img src="https://tracker.example/pixel.gif?u=1" width="1"><div style="background:url(https://evil.example/bg.png)">x</div>';

describe('prepareEmailHtml', () => {
  it('blocks remote images, CSS backgrounds and tracking pixels by default', () => {
    const { srcDoc, blockedCount } = prepareEmailHtml(tracker);
    expect(blockedCount).toBe(2);
    expect(srcDoc).not.toContain('tracker.example');
    expect(srcDoc).not.toContain('evil.example');
    expect(srcDoc).toContain("img-src data:;");
  });

  it('shows remote images only when the reader allows them', () => {
    const { srcDoc, blockedCount } = prepareEmailHtml(tracker, { allowRemote: true });
    expect(blockedCount).toBe(0);
    expect(srcDoc).toContain('https://tracker.example/pixel.gif');
    expect(srcDoc).toContain('img-src data: https: http:');
  });

  it('removes scripts, forms, iframes, meta refresh and event handlers', () => {
    const { srcDoc } = prepareEmailHtml(`
      <script>alert(1)</script><form action="https://phish.example"><input name="password"></form>
      <iframe src="https://x.example"></iframe><meta http-equiv="refresh" content="0;url=https://x.example">
      <img src="data:image/png;base64,AAAA" onerror="alert(1)"><a href="javascript:alert(1)">bad</a>`);
    const body = srcDoc.split('<body>')[1].replace(/<script>[^<]*<\/script>/, '');
    for (const fragment of ['<script', '<form', '<input', '<iframe', 'refresh', 'onerror', 'javascript:']) {
      expect(body).not.toContain(fragment);
    }
  });

  it('allows only the fixed height reporter to run, by hash', async () => {
    const { FRAME_REPORTER } = await import('../src/frameReporter.js');
    const { createHash } = await import('node:crypto');
    const hash = `sha256-${createHash('sha256').update(FRAME_REPORTER, 'utf8').digest('base64')}`;
    const { srcDoc } = prepareEmailHtml('<p>hi</p><script>alert(1)</script><img src=x onerror="alert(2)">');
    expect(srcDoc).toContain(`script-src '${hash}'`);
    expect(srcDoc).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(srcDoc.match(/<script/g)).toHaveLength(1);
    expect(srcDoc).toContain(`<script>${FRAME_REPORTER}</script>`);
    expect(srcDoc).not.toMatch(/alert\(/);
  });

  it('opens every link in a new window so the app can confirm it', () => {
    const { srcDoc } = prepareEmailHtml('<a href="https://bank.example/login">Login</a>');
    expect(srcDoc).toMatch(/<a href="https:\/\/bank\.example\/login" target="_blank" rel="noopener noreferrer">/);
  });

  it('replaces cid: inline images with the attachment data', () => {
    const { srcDoc } = prepareEmailHtml('<img src="cid:logo@x">', { inlineImages: { 'logo@x': 'data:image/png;base64,QUJD' } });
    expect(srcDoc).toContain('src="data:image/png;base64,QUJD"');
  });

  it('strips remote @import and url() inside style tags', () => {
    const { srcDoc, blockedCount } = prepareEmailHtml('<style>@import url(https://x.example/a.css); body{background:url("https://x.example/b.png")}</style><p>t</p>');
    expect(srcDoc).not.toContain('x.example');
    expect(blockedCount).toBe(1);
  });
});

describe('printableEmailHtml', () => {
  const labels = { from: 'From', to: 'To', cc: 'Cc', date: 'Date', attachments: 'Attachments' };
  it('prints the headers and the sanitized body, with no script and no remote images', () => {
    const page = printableEmailHtml({
      subject: 'Offer <b>now</b>', from: 'Osama <o@x.test>', to: 'me@x.test', date: '21 Nov 2026',
      html: `${tracker}<script>alert(1)</script><img src="cid:logo">`, inlineImages: { logo: 'data:image/png;base64,AAAA' },
      attachments: [{ filename: 'offer.pdf' }],
    }, { labels, dir: 'rtl', lang: 'ar' });
    expect(page).toContain('dir="rtl"');
    expect(page).toContain('Offer &lt;b&gt;now&lt;/b&gt;');
    expect(page).toContain('Osama &lt;o@x.test&gt;');
    expect(page).toContain('offer.pdf');
    expect(page).toContain('data:image/png;base64,AAAA');
    expect(page).not.toContain('<script');
    expect(page).not.toContain('tracker.example');
    expect(page).toContain("script-src 'none'");
    expect(page).not.toContain('Cc');
  });

  it('keeps plain-text mail as text', () => {
    const page = printableEmailHtml({ subject: 's', text: 'a <b> c' }, { labels });
    expect(page).toContain('a &lt;b&gt; c');
  });
});
