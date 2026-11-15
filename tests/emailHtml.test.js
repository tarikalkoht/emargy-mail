// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { prepareEmailHtml } from '../src/emailHtml.js';

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
    const body = srcDoc.split('<body>')[1];
    for (const fragment of ['<script', '<form', '<input', '<iframe', 'refresh', 'onerror', 'javascript:']) {
      expect(body).not.toContain(fragment);
    }
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
