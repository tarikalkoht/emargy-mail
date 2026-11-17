const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, clipboard, nativeImage, Notification, dialog, ipcMain, safeStorage, session, shell } = require('electron');
const { Vault } = require('./vault.cjs');
const { Database } = require('./db.cjs');
const { SyncManager } = require('./sync.cjs');
const { Outbox } = require('./outbox.cjs');
const { createApi } = require('./api.cjs');
const ai = require('./ai.cjs');
const oauth = require('./oauth.cjs');
const { Updater } = require('./updater.cjs');
const { ImportanceWatcher } = require('./importance.cjs');
const { selectNotifications, notificationText } = require('./notify.cjs');
const { DEFAULT_SETTINGS } = require('./api.cjs');
const { migrateLegacyStore } = require('./migrate.cjs');

const DEV_URL = process.env.VITE_DEV_SERVER_URL || (!app.isPackaged && !process.env.EMARGY_USE_DIST ? 'http://127.0.0.1:5173' : null);
const SAFE_EXTERNAL = new Set(['https:', 'http:', 'mailto:']);
const MAX_PICKED_FILE = 20 * 1024 * 1024;

let mainWindow;
let db;
let sync;
let outbox;
let api;
let updater;
let importance;

// A separate data folder for demos and automated tests, so real data is never touched.
if (process.env.EMARGY_DATA_DIR) app.setPath('userData', path.resolve(process.env.EMARGY_DATA_DIR));

app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function isAppUrl(url) {
  if (!url) return false;
  if (DEV_URL && url.startsWith(DEV_URL)) return true;
  return url.startsWith('file://');
}

async function openExternalSafely(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!SAFE_EXTERNAL.has(parsed.protocol)) return;
  const target = parsed.protocol === 'mailto:' ? parsed.href : `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  const arabic = db?.getSetting('language', 'en') === 'ar';
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: arabic ? ['فتح الرابط', 'إلغاء'] : ['Open link', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: arabic ? 'فتح رابط خارجي' : 'Open external link',
    message: arabic ? `هل تريد فتح هذا الرابط في المتصفح؟\n\nالموقع: ${parsed.host || parsed.href}` : `Open this link in your browser?\n\nSite: ${parsed.host || parsed.href}`,
    detail: target.slice(0, 600),
    noLink: true,
  });
  if (response === 0) await shell.openExternal(parsed.href);
}

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  // The interface never talks to the internet. The only remote requests allowed
  // are images inside an email the user chose to show (the email frame's own CSP
  // blocks them otherwise). Mail traffic happens in the main process, not here.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const { url, resourceType } = details;
    if (isAppUrl(url) || url.startsWith('data:') || url.startsWith('devtools:') || url.startsWith('blob:') || url === 'about:srcdoc') return callback({});
    if (DEV_URL && url.startsWith(DEV_URL.replace('http', 'ws'))) return callback({});
    if (resourceType === 'image' && /^https?:/i.test(url)) return callback({});
    callback({ cancel: true });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1050,
    minHeight: 650,
    // Windows and macOS take the icon from the app itself; Linux windows need it set, and so
    // does a copy run from source.
    ...(process.platform === 'linux' ? { icon: path.join(__dirname, '..', 'build', 'icon.png') }
      : app.isPackaged ? {} : { icon: path.join(__dirname, '..', 'build', 'icon.ico') }),
    backgroundColor: '#07111f',
    show: false,
    title: 'Emargy Mail',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    if (event.url === 'about:srcdoc' || event.url === 'about:blank') return;
    event.preventDefault();
    openExternalSafely(event.url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // On macOS the app keeps running after the window closes; the Dock icon opens a new one.
  mainWindow.on('closed', () => { mainWindow = null; });
}

/** macOS needs an application menu, or Copy, Paste and Quit stop working. */
function setMenu() {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  } else if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }
}

/** Unread count on the taskbar (Windows overlay), the Dock (macOS) or the launcher (Linux). */
function setUnreadBadge(image, label) {
  const count = Number.parseInt(label, 10) || 0;
  if (process.platform === 'darwin') { app.dock?.setBadge(count ? String(label) : ''); return true; }
  if (process.platform === 'linux') { app.setBadgeCount(count); return true; }
  if (!mainWindow) return false;
  if (!image) { mainWindow.setOverlayIcon(null, ''); return true; }
  mainWindow.setOverlayIcon(nativeImage.createFromDataURL(image), String(label || '').slice(0, 80));
  return true;
}

/** Where each system keeps the key that unlocks the encrypted database. */
const KEY_STORE = { win32: 'Windows data protection', darwin: 'the macOS Keychain', linux: 'a system keyring (GNOME Keyring or KWallet)' };

/**
 * The database key must be protected by the operating system. On Linux without a keyring,
 * Electron falls back to a fixed built-in password ("basic_text"), which protects nothing,
 * so that case is refused rather than storing secrets that anyone could read.
 */
function secureStorageReady() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
    return !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend());
  }
  return true;
}

/** Accept IPC only from this app's own top-level page. */
function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !isAppUrl(event.senderFrame.url)) {
      throw new Error('Request rejected.');
    }
    return handler(...args);
  });
}

function registerHandlers() {
  handle('state:get', () => api.state());
  handle('settings:language', (language) => api.setLanguage(language));
  handle('settings:update', (changes) => {
    const result = api.updateSettings(changes);
    if (changes?.aiAlerts) importance.runOnce().catch(() => {});
    if (changes && 'autoUpdate' in changes) {
      if (result.settings.autoUpdate) updater.start(1000);
      else updater.stop();
    }
    return result;
  });
  handle('ai:status', () => ai.status());
  handle('ai:run', (request) => ai.run({
    task: String(request?.task || ''),
    text: String(request?.text || ''),
    language: request?.language === 'ar' ? 'ar' : 'en',
    preference: api.state().settings.aiProvider,
  }));
  handle('ai:cancel', () => ai.cancel());
  // Only these fixed pages can be opened this way (no URL comes from the interface).
  handle('help:open', (key) => {
    const pages = {
      googleAppPassword: 'https://myaccount.google.com/apppasswords',
      google2sv: 'https://myaccount.google.com/signinoptions/twosv',
      releases: 'https://github.com/tarikalkoht/emargy-mail/releases',
    };
    if (!pages[key]) throw new Error('Unknown page.');
    return shell.openExternal(pages[key]);
  });
  handle('importance:status', () => ({ running: importance.running, error: importance.lastError }));
  handle('importance:run', () => importance.runOnce());
  handle('update:status', () => updater.status);
  handle('update:check', () => updater.check());
  handle('update:install', () => updater.install());
  handle('scene:get', () => api.sceneImage());
  handle('scene:set', (dataUrl) => api.setSceneImage(dataUrl ?? null));
  // Unread count on the taskbar button, drawn by the interface as a small PNG.
  handle('badge:set', ({ image, label } = {}) => {
    if (image && (!/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(String(image)) || image.length > 60_000)) throw new Error('Invalid badge.');
    return setUnreadBadge(image, image ? label : '');
  });
  handle('clipboard:write', (value) => { clipboard.writeText(String(value ?? '').slice(0, 200_000)); return true; });
  handle('project:create', (input) => api.createProject(input));
  handle('project:delete', (id) => api.deleteProject(id));
  handle('account:detect', (email) => api.detectServers(email));
  handle('account:add', (input) => api.addAccount(input));
  handle('account:update', (id, changes) => api.updateAccount(id, changes));
  handle('account:delete', (id) => api.deleteAccount(id));
  handle('account:reorder', (ids) => api.reorderAccounts(ids));
  // Microsoft sign-in opens the reader's own browser; the token never passes through the interface.
  handle('account:microsoft', async (input) => {
    const signed = await oauth.signIn({ loginHint: String(input?.email || '').slice(0, 320), openBrowser: (url) => shell.openExternal(url) });
    return api.addOAuthAccount(input, signed);
  });
  handle('account:microsoftRenew', async (accountId) => {
    const account = api.state().accounts.find((a) => a.id === accountId);
    if (!account) throw new Error('Account not found.');
    const signed = await oauth.signIn({ loginHint: account.email, openBrowser: (url) => shell.openExternal(url) });
    return api.renewOAuth(accountId, signed);
  });
  handle('microsoft:available', () => Boolean(oauth.MICROSOFT.clientId));
  handle('messages:allRead', (params) => api.markAllRead(params));
  handle('messages:older', (params) => api.loadOlder(params));
  handle('messages:searchServer', (params) => api.searchServer(params));
  handle('account:sync', (id) => api.syncAccount(id));
  handle('folder:sync', (id) => api.syncFolder(id));
  handle('sync:all', () => api.syncAll());
  handle('messages:list', (params) => api.listMessages(params));
  handle('thread:open', (id) => api.openThread(id));
  handle('thread:ids', (id, sameFolder) => api.threadIds(id, sameFolder));
  handle('messages:read', (ids, read) => api.setRead(ids, read));
  handle('messages:flag', (ids, flagged) => api.setFlagged(ids, flagged));
  handle('messages:archive', (ids) => api.archive(ids));
  handle('messages:trash', (ids) => api.trash(ids));
  handle('messages:move', (ids, folderId) => api.moveTo(ids, folderId));
  handle('images:trust', (address) => api.trustImages(address));
  handle('contacts:search', (query) => api.contacts(query));
  handle('attachments:forward', (messageId) => api.forwardAttachments(messageId));
  handle('signature:save', (input) => api.saveSignature(input));
  handle('signature:delete', (id) => api.deleteSignature(id));
  handle('draft:save', (draft) => api.saveDraft(draft));
  handle('draft:get', (id) => api.getDraft(id));
  handle('draft:delete', (id) => api.deleteDraft(id));
  handle('draft:send', (draft) => api.approveAndSend(draft));
  handle('send:undo', (id) => api.cancelSend(id));
  handle('outbox:retry', (id) => api.retryOutbox(id));
  handle('outbox:remove', (id) => api.removeOutbox(id));
  handle('audit:list', () => api.audit());

  handle('compose:pickImage', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    if (fs.statSync(file).size > 5 * 1024 * 1024) throw new Error('Images must be smaller than 5 MB.');
    const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
    return `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}`;
  });

  handle('attachment:save', async ({ messageId, index }) => {
    const file = await api.attachment(messageId, index);
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: path.basename(file.filename) });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, file.content);
    db.audit('attachment.saved', { messageId, filename: path.basename(file.filename) });
    return result.filePath;
  });

  handle('compose:pickFiles', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return [];
    return result.filePaths.map((file) => {
      const size = fs.statSync(file).size;
      if (size > MAX_PICKED_FILE) throw new Error(`${path.basename(file)} is larger than 20 MB.`);
      return { filename: path.basename(file), contentType: 'application/octet-stream', size, content: fs.readFileSync(file).toString('base64') };
    });
  });
}

const liveNotifications = new Set(); // keep a reference so Windows click events still arrive

function preferences() {
  return api.state().settings;
}

function showNotification({ title, body, silent, onClick }) {
  const notice = new Notification({ title: String(title).slice(0, 120), body: String(body || '').slice(0, 240), silent });
  liveNotifications.add(notice);
  const release = () => liveNotifications.delete(notice);
  notice.on('click', () => {
    release();
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    onClick?.();
  });
  notice.on('close', release);
  notice.show();
}

function notifyNewMail({ newInbox = [] }) {
  if (!newInbox.length || !Notification.isSupported()) return;
  const prefs = preferences();
  const arabic = db.getSetting('language', 'en') === 'ar';
  const projects = new Map(db.listProjects().map((p) => [p.id, p.name]));
  for (const group of selectNotifications(newInbox, prefs)) {
    const text = notificationText(group, { projectName: projects.get(group.projectId) || '', arabic, preview: prefs.notifyPreview !== false });
    const single = group.items.length === 1;
    showNotification({
      ...text,
      silent: prefs.notifySound === false,
      onClick: () => (single ? emit('open:message', { id: group.items[0].id }) : emit('open:scope', { kind: 'project', projectId: group.projectId })),
    });
  }
}

const CATEGORY_LABELS = {
  ar: { offer: 'عرض', government: 'جهة حكومية', project: 'مشروع', invoice: 'فاتورة', legal: 'قانوني', meeting: 'اجتماع', other: 'مهم' },
  en: { offer: 'Offer', government: 'Government', project: 'Project', invoice: 'Invoice', legal: 'Legal', meeting: 'Meeting', other: 'Important' },
};

function notifyImportant(found) {
  if (!found.length || !Notification.isSupported()) return;
  const prefs = preferences();
  // Important mail passes quiet hours, but "off" and muted projects are respected.
  const messages = selectNotifications(found.map((m) => ({ ...m, aiImportant: true })), { ...prefs, notifyMode: prefs.notifyMode === 'off' ? 'off' : 'important' })
    .flatMap((group) => group.items);
  if (!messages.length) return;
  const arabic = db.getSetting('language', 'en') === 'ar';
  const first = messages[0];
  const label = CATEGORY_LABELS[arabic ? 'ar' : 'en'][first.aiNote?.category] || '';
  const preview = prefs.notifyPreview !== false;
  showNotification({
    title: messages.length === 1
      ? (arabic ? `بريد مهم · ${label}` : `Important mail · ${label}`)
      : (arabic ? `${messages.length} رسائل مهمة تحتاج انتباهك` : `${messages.length} important messages need you`),
    body: preview ? `${first.from} · ${first.subject}\n${first.aiNote?.reason || ''}` : (first.aiNote?.reason || ''),
    silent: prefs.notifySound === false,
    onClick: () => emit(messages.length === 1 ? 'open:message' : 'open:scope', messages.length === 1 ? { id: first.id } : { kind: 'unified', role: 'important' }),
  });
}

function openStorage() {
  if (!secureStorageReady()) {
    throw new Error(`Emargy Mail keeps its encryption key in ${KEY_STORE[process.platform] || 'the system key store'}, which is not available, so it cannot store your data securely.`);
  }
  const dataDir = app.getPath('userData');
  const vault = new Vault({
    keyFile: path.join(dataDir, 'vault.key'),
    protect: (key) => safeStorage.encryptString(key.toString('base64')),
    unprotect: (data) => Buffer.from(safeStorage.decryptString(data), 'base64'),
  });
  db = new Database({ file: path.join(dataDir, 'emargy.db'), vault });
  // The prototype stored data in a plaintext JSON file (in a differently named folder when run from source).
  const legacyFiles = new Set([path.join(dataDir, 'emargy-mail.json')]);
  if (!process.env.EMARGY_DATA_DIR) legacyFiles.add(path.join(app.getPath('appData'), 'emargy-mail', 'emargy-mail.json'));
  for (const legacyFile of legacyFiles) {
    migrateLegacyStore({
      db,
      legacyFile,
      decryptLegacySecret: (secret) => (secret ? safeStorage.decryptString(Buffer.from(secret, 'base64')) : ''),
    });
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  try {
    openStorage();
  } catch (error) {
    dialog.showErrorBox('Emargy Mail', error.message);
    app.quit();
    return;
  }
  setMenu();
  hardenSession();
  const forward = (channel, payload) => {
    emit(channel, payload);
    if (channel === 'mail:changed') {
      notifyNewMail(payload);
      if (payload?.newInbox?.length) importance?.poke();
    }
  };
  // EMARGY_INITIAL_WINDOW only exists so tests can use a small mailbox.
  sync = new SyncManager({ db, emit: forward, initialWindow: Number(process.env.EMARGY_INITIAL_WINDOW) || undefined });
  outbox = new Outbox({ db, sync, emit: forward });
  api = createApi({ db, sync, outbox, emit: forward });
  updater = new Updater({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    // EMARGY_STORE only exists so tests can act like the Store package.
    store: Boolean(process.windowsStore) || process.env.EMARGY_STORE === '1',
    emit: (status) => emit('update:status', status),
    onQuit: () => app.quit(),
  });
  importance = new ImportanceWatcher({
    db,
    ai,
    settings: () => ({ ...DEFAULT_SETTINGS, ...db.getSetting('preferences', {}) }),
    language: () => db.getSetting('language', 'en'),
    emit,
    notify: notifyImportant,
  });
  registerHandlers();
  createWindow();
  setTimeout(() => importance.poke(), 15_000);
  sync.start();
  outbox.start();
  if (api.state().settings.autoUpdate) updater.start();
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !sync) return;
  event.preventDefault();
  quitting = true;
  outbox?.stop();
  sync.stop().finally(() => {
    db?.close();
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow && db) createWindow();
});
