import DOMPurify from 'dompurify';

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
export function prepareEmailHtml(html, { allowRemote = false, inlineImages = {} } = {}) {
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
  const imageSources = allowRemote ? 'data: https: http:' : 'data:';
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${imageSources}; font-src data:; media-src 'none'; form-action 'none'`;
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + '<base target="_blank"><style>body{font-family:Segoe UI,Tahoma,Arial,sans-serif;color:#20242a;line-height:1.55;margin:24px;overflow-wrap:anywhere}'
    + 'img{max-width:100%;height:auto}img[data-blocked]{display:inline-block;min-width:24px;min-height:16px;background:#eef1f5;outline:1px dashed #b7c0cc}a{color:#0b66d4}</style>'
    + `</head><body>${body}</body></html>`;
  return { srcDoc, blockedCount: counter.blocked };
}
