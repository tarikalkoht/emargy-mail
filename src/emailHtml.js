import DOMPurify from 'dompurify';
import { FRAME_REPORTER } from './frameReporter';

const REMOTE = /^\s*(https?:)?\/\//i;
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

const FORBID_TAGS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea', 'select',
  'option', 'link', 'meta', 'base', 'audio', 'video', 'source', 'track', 'portal', 'noscript',
];

function rewriteCssUrls(css, allowRemote, inlineImages, counter) {
  return css.replace(CSS_URL, (match, _quote, url) => {
    if (/^cid:/i.test(url)) {
      const data = inlineImages[url.slice(4)];
      return data ? `url("${data}")` : 'none';
    }
    if (REMOTE.test(url)) {
      if (allowRemote) return match;
      counter.blocked += 1;
      return 'none';
    }
    return /^data:image\//i.test(url) ? match : 'none';
  });
}

/**
 * Clean HTML that goes into the editor (quoted replies, pasted content):
 * no scripts, no remote images (they would load trackers while composing).
 */
export function sanitizeForEditor(html) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      // An <img> without src is dropped by the editor's image parser.
      if (!/^data:image\//i.test(src)) node.removeAttribute('src');
      node.removeAttribute('srcset');
    }
    if (node.hasAttribute?.('style')) node.setAttribute('style', node.getAttribute('style').replace(CSS_URL, 'none'));
  });
  try {
    return DOMPurify.sanitize(html || '', { FORBID_TAGS: [...FORBID_TAGS, 'style'], FORBID_ATTR: ['srcdoc', 'background'], ALLOW_DATA_ATTR: false });
  } finally {
    DOMPurify.removeAllHooks();
  }
}

/**
 * Turn untrusted email HTML into a document that can be shown in a sandboxed
 * iframe. Scripts, forms and embeds are removed; remote images and CSS
 * backgrounds are blocked unless the reader allows them; every link opens
 * through the app's confirmation dialog. A strict Content-Security-Policy is
 * added as a second layer in case anything slips through.
 */
/** The email body, sanitized: no scripts, forms or remote content unless allowed. */
function sanitizeEmailBody(html, { allowRemote = false, inlineImages = {} } = {}) {
  const counter = { blocked: 0 };
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      if (/^cid:/i.test(src)) {
        const data = inlineImages[src.slice(4)];
        if (data) node.setAttribute('src', data);
        else node.removeAttribute('src');
      } else if (REMOTE.test(src) && !allowRemote) {
        counter.blocked += 1;
        node.removeAttribute('src');
        node.setAttribute('data-blocked', 'true');
      }
      if (!allowRemote) node.removeAttribute('srcset');
    }
    if (node.hasAttribute?.('background')) {
      const value = node.getAttribute('background');
      if (REMOTE.test(value) && !allowRemote) {
        counter.blocked += 1;
        node.removeAttribute('background');
      }
    }
    if (node.hasAttribute?.('style')) {
      node.setAttribute('style', rewriteCssUrls(node.getAttribute('style'), allowRemote, inlineImages, counter));
    }
  });
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'style' && node.textContent) {
      node.textContent = rewriteCssUrls(node.textContent.replace(/@import[^;]+;?/gi, ''), allowRemote, inlineImages, counter);
    }
  });
  let body;
  try {
    body = DOMPurify.sanitize(html || '', {
      FORBID_TAGS,
      FORBID_ATTR: ['srcdoc', 'formaction', 'action', 'ping', 'http-equiv'],
      FORCE_BODY: true,
      ALLOW_DATA_ATTR: false,
      ADD_ATTR: ['target'],
    });
  } finally {
    DOMPurify.removeAllHooks();
  }
  return { body, blocked: counter.blocked };
}

export function prepareEmailHtml(html, { allowRemote = false, inlineImages = {} } = {}) {
  const { body, blocked } = sanitizeEmailBody(html, { allowRemote, inlineImages });
  // One fixed, app-authored script reports the content height to the parent. It is
  // allowed only by its SHA-256 hash; the email's own scripts were removed above and any
  // other script is refused by the CSP. The frame has an opaque origin (no
  // allow-same-origin), so even a script could not reach the app.
  const imageSources = allowRemote ? 'data: https: http:' : 'data:';
  const csp = `default-src 'none'; script-src '${FRAME_REPORTER_HASH}'; style-src 'unsafe-inline'; img-src ${imageSources}; font-src data:; media-src 'none'; form-action 'none'; connect-src 'none'`;
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<base target="_blank"><style>html{overflow:hidden}body{${FRAME_BODY_CSS}}${FRAME_CSS}</style>`
    + `</head><body>${body}<script>${FRAME_REPORTER}</script></body></html>`;
  return { srcDoc, blockedCount: blocked };
}

const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * A page to print one message: its headers, then the sanitized body. It carries no script
 * at all, and remote images appear only when the reader already chose to show them.
 * labels: { from, to, cc, date, subject, attachments } in the interface language.
 */
export function printableEmailHtml({ subject, from, to, cc, date, html, text, inlineImages = {}, allowRemote = false, attachments = [] }, { labels, dir = 'ltr', lang = 'en' }) {
  const content = html
    ? sanitizeEmailBody(html, { allowRemote, inlineImages }).body
    : `<div style="white-space:pre-wrap">${escapeText(text)}</div>`;
  const row = (label, value) => (value ? `<tr><th>${escapeText(label)}</th><td dir="auto">${escapeText(value)}</td></tr>` : '');
  const files = attachments.length ? row(labels.attachments, attachments.map((a) => a.filename).join(', ')) : '';
  const imageSources = allowRemote ? 'data: https: http:' : 'data:';
  const csp = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${imageSources}; font-src data:; media-src 'none'; form-action 'none'; connect-src 'none'`;
  return `<!doctype html><html lang="${escapeText(lang)}" dir="${dir === 'rtl' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${csp}"><title>${escapeText(subject)}</title>`
    + '<style>@page{margin:16mm}body{font-family:Segoe UI,Tahoma,Arial,sans-serif;color:#111;margin:0}'
    + '.print-head{border-bottom:1px solid #999;padding-bottom:10px;margin-bottom:14px}'
    + '.print-head h1{font-size:18px;margin:0 0 8px}.print-head table{border-collapse:collapse;font-size:12.5px}'
    + '.print-head th{text-align:start;color:#555;font-weight:600;padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap}'
    + '.print-head td{padding:2px 0}.print-body{overflow-wrap:anywhere;line-height:1.5}img{max-width:100%;height:auto}</style></head><body>'
    + `<header class="print-head"><h1 dir="auto">${escapeText(subject)}</h1><table>`
    + row(labels.from, from) + row(labels.to, to) + row(labels.cc, cc) + row(labels.date, date) + files
    + `</table></header><main class="print-body">${content}</main></body></html>`;
}

// Injected by vite.config.mjs at build time.
/* global __FRAME_REPORTER_HASH__ */
const FRAME_REPORTER_HASH = __FRAME_REPORTER_HASH__;

const FRAME_BODY_CSS = 'font-family:Segoe UI,Tahoma,Arial,sans-serif;color:#20242a;line-height:1.55;margin:0;padding:14px 18px 18px;overflow-wrap:anywhere;display:flow-root';
const FRAME_CSS = 'img{max-width:100%;height:auto}img[data-blocked]{display:inline-block;min-width:24px;min-height:16px;background:#eef1f5;outline:1px dashed #b7c0cc}a{color:#0b66d4}';
