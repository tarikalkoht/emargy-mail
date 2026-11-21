/**
 * Printing a message. The page (built by the interface from the sanitized email, with no
 * script) is shown in a hidden window that has JavaScript turned off and its own in-memory
 * session, then handed to the system print dialog (which also offers "Save as PDF").
 * Nothing is written to disk.
 */
const crypto = require('node:crypto');

const SCHEME = 'emargy-print';
const MAX_PAGE = 30 * 1024 * 1024;

function createPrinter({ BrowserWindow, session, parent = () => null }) {
  const jobs = new Map();
  let ses = null;

  function printSession() {
    if (ses) return ses;
    ses = session.fromPartition('emargy-print'); // no "persist:": memory only
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    ses.protocol.handle(SCHEME, (request) => {
      const id = String(request.url).replace(`${SCHEME}://`, '').replace(/\/.*$/, '');
      const page = jobs.get(id);
      return new Response(page ?? '', { status: page ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
    // Only the page itself and images the reader already allowed (the page's CSP decides).
    ses.webRequest.onBeforeRequest((details, callback) => {
      const { url, resourceType } = details;
      if (url.startsWith(`${SCHEME}:`) || url.startsWith('data:')) return callback({});
      if (resourceType === 'image' && /^https?:/i.test(url)) return callback({});
      return callback({ cancel: true });
    });
    return ses;
  }

  /** Load the page in a hidden window; returns the window (the caller prints and destroys it). */
  async function open(html) {
    const page = String(html || '');
    if (!page || page.length > MAX_PAGE) throw new Error('This message cannot be printed.');
    printSession();
    const id = crypto.randomUUID();
    jobs.set(id, page);
    const win = new BrowserWindow({
      show: false,
      parent: parent() || undefined,
      webPreferences: { partition: 'emargy-print', sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false, spellcheck: false, webviewTag: false },
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      await win.loadURL(`${SCHEME}://${id}/`);
    } catch (error) {
      win.destroy();
      throw error;
    } finally {
      jobs.delete(id);
    }
    return win;
  }

  /** The system print dialog. Resolves true when printed, false when the reader cancelled. */
  async function print(html) {
    const win = await open(html);
    try {
      return await new Promise((resolve, reject) => {
        win.webContents.print({ silent: false, printBackground: true }, (printed, reason) => {
          if (printed) resolve(true);
          else if (!reason || /cancel/i.test(reason)) resolve(false);
          else reject(new Error(`Printing failed: ${reason}`));
        });
      });
    } finally {
      win.destroy();
    }
  }

  return { open, print };
}

module.exports = { createPrinter };
