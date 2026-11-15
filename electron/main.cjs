const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, Notification } = require('electron');
const { Store } = require('./store.cjs');
const { fetchMessage, sendMessage, syncInbox } = require('./mail.cjs');

let mainWindow;
let store;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1050,
    minHeight: 650,
    backgroundColor: '#07111f',
    show: false,
    title: 'Emargy Mail',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (!app.isPackaged) {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function accountById(id) {
  const account = store.state.accounts.find((item) => item.id === id);
  if (!account) throw new Error('Account not found.');
  return account;
}

function stateAfterSave() {
  store.save();
  return store.publicState();
}

function registerHandlers() {
  ipcMain.handle('state:get', () => store.publicState());

  ipcMain.handle('settings:language', (_event, language) => {
    store.state.language = language === 'ar' ? 'ar' : 'en';
    return stateAfterSave();
  });

  ipcMain.handle('project:create', (_event, input) => {
    const project = {
      id: store.id(),
      name: String(input.name || '').trim(),
      color: input.color || '#2d8cff',
      createdAt: new Date().toISOString(),
    };
    if (!project.name) throw new Error('Project name is required.');
    store.state.projects.push(project);
    store.audit('project.created', { projectId: project.id, name: project.name });
    return stateAfterSave();
  });

  ipcMain.handle('project:delete', (_event, id) => {
    const hasAccounts = store.state.accounts.some((account) => account.projectId === id);
    if (hasAccounts) throw new Error('Delete the project accounts first.');
    store.state.projects = store.state.projects.filter((project) => project.id !== id);
    store.audit('project.deleted', { projectId: id });
    return stateAfterSave();
  });

  ipcMain.handle('account:add', (_event, input) => {
    if (!store.state.projects.some((project) => project.id === input.projectId)) {
      throw new Error('Choose a valid project.');
    }
    const account = {
      id: store.id(),
      projectId: input.projectId,
      provider: input.provider || 'custom',
      displayName: String(input.displayName || '').trim(),
      email: String(input.email || '').trim(),
      imapHost: String(input.imapHost || '').trim(),
      imapPort: Number(input.imapPort || 993),
      imapSecure: input.imapSecure !== false,
      smtpHost: String(input.smtpHost || '').trim(),
      smtpPort: Number(input.smtpPort || 465),
      smtpSecure: input.smtpSecure !== false,
      inboxPath: input.inboxPath || 'INBOX',
      encryptedPassword: store.encrypt(input.password),
      createdAt: new Date().toISOString(),
      lastSyncAt: null,
      lastError: null,
    };
    if (!account.email || !account.imapHost || !account.smtpHost || !input.password) {
      throw new Error('Email, password, IMAP, and SMTP settings are required.');
    }
    store.state.accounts.push(account);
    store.audit('account.created', { accountId: account.id, projectId: account.projectId, email: account.email });
    return stateAfterSave();
  });

  ipcMain.handle('account:delete', (_event, id) => {
    store.state.accounts = store.state.accounts.filter((account) => account.id !== id);
    store.state.messages = store.state.messages.filter((message) => message.accountId !== id);
    store.state.drafts = store.state.drafts.filter((draft) => draft.accountId !== id);
    store.audit('account.deleted', { accountId: id });
    return stateAfterSave();
  });

  ipcMain.handle('account:sync', async (_event, id) => {
    const account = accountById(id);
    mainWindow.webContents.send('sync:status', { accountId: id, status: 'syncing' });
    try {
      const previous = new Set(store.state.messages.filter((message) => message.accountId === id).map((message) => message.id));
      const synced = await syncInbox(account, store.decrypt(account.encryptedPassword));
      const newMessages = synced.filter((message) => !previous.has(message.id));
      store.state.messages = [
        ...synced,
        ...store.state.messages.filter((message) => message.accountId !== id),
      ].sort((a, b) => new Date(b.date) - new Date(a.date));
      account.lastSyncAt = new Date().toISOString();
      account.lastError = null;
      store.audit('account.synced', { accountId: id, messages: synced.length, newMessages: newMessages.length });
      store.save();
      if (newMessages.length && Notification.isSupported()) {
        new Notification({
          title: `${newMessages.length} new message${newMessages.length === 1 ? '' : 's'}`,
          body: `${account.email} · ${newMessages[0].subject}`,
        }).show();
      }
      mainWindow.webContents.send('sync:status', { accountId: id, status: 'idle' });
      return store.publicState();
    } catch (error) {
      account.lastError = error.message;
      store.audit('account.sync_failed', { accountId: id, error: error.message });
      store.save();
      mainWindow.webContents.send('sync:status', { accountId: id, status: 'error', error: error.message });
      throw error;
    }
  });

  ipcMain.handle('message:get', async (_event, id) => {
    const message = store.state.messages.find((item) => item.id === id);
    if (!message) throw new Error('Message not found.');
    if (message.content) return { ...message, content: message.content };
    const account = accountById(message.accountId);
    const content = await fetchMessage(account, store.decrypt(account.encryptedPassword), message.uid, message.folder);
    message.content = content;
    message.preview = (content.text || '').slice(0, 240);
    message.read = true;
    store.save();
    return { ...message, content };
  });

  ipcMain.handle('message:read', (_event, { id, read }) => {
    const message = store.state.messages.find((item) => item.id === id);
    if (message) message.read = Boolean(read);
    return stateAfterSave();
  });

  ipcMain.handle('draft:save', (_event, input) => {
    const now = new Date().toISOString();
    const existing = input.id && store.state.drafts.find((draft) => draft.id === input.id);
    const draft = existing || { id: store.id(), createdAt: now, status: 'draft' };
    Object.assign(draft, {
      accountId: input.accountId,
      projectId: accountById(input.accountId).projectId,
      to: input.to || '',
      cc: input.cc || '',
      bcc: input.bcc || '',
      subject: input.subject || '',
      body: input.body || '',
      updatedAt: now,
      status: 'draft',
    });
    if (!existing) store.state.drafts.unshift(draft);
    store.audit('draft.saved', { draftId: draft.id, accountId: draft.accountId });
    store.save();
    return { state: store.publicState(), draft };
  });

  ipcMain.handle('draft:delete', (_event, id) => {
    store.state.drafts = store.state.drafts.filter((draft) => draft.id !== id);
    store.audit('draft.deleted', { draftId: id });
    return stateAfterSave();
  });

  ipcMain.handle('draft:send', async (_event, id) => {
    const draft = store.state.drafts.find((item) => item.id === id);
    if (!draft) throw new Error('Draft not found.');
    const account = accountById(draft.accountId);
    const result = await sendMessage(account, store.decrypt(account.encryptedPassword), draft);
    draft.status = 'sent';
    draft.sentAt = new Date().toISOString();
    draft.messageId = result.messageId;
    store.audit('draft.sent_with_user_approval', { draftId: id, accountId: account.id, messageId: result.messageId });
    store.save();
    return { state: store.publicState(), result };
  });

  ipcMain.handle('attachment:save', async (_event, attachment) => {
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: attachment.filename });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, Buffer.from(attachment.content, 'base64'));
    return result.filePath;
  });
}

app.whenReady().then(() => {
  store = new Store();
  registerHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

