const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('emargy', {
  getState: invoke('state:get'),
  setLanguage: invoke('settings:language'),
  updateSettings: invoke('settings:update'),
  createProject: invoke('project:create'),
  deleteProject: invoke('project:delete'),
  detectServers: invoke('account:detect'),
  addAccount: invoke('account:add'),
  updateAccount: invoke('account:update'),
  deleteAccount: invoke('account:delete'),
  syncAccount: invoke('account:sync'),
  syncFolder: invoke('folder:sync'),
  syncAll: invoke('sync:all'),
  listMessages: invoke('messages:list'),
  openThread: invoke('thread:open'),
  markRead: invoke('messages:read'),
  setFlagged: invoke('messages:flag'),
  archive: invoke('messages:archive'),
  trash: invoke('messages:trash'),
  moveTo: invoke('messages:move'),
  trustImages: invoke('images:trust'),
  searchContacts: invoke('contacts:search'),
  saveSignature: invoke('signature:save'),
  deleteSignature: invoke('signature:delete'),
  saveDraft: invoke('draft:save'),
  getDraft: invoke('draft:get'),
  deleteDraft: invoke('draft:delete'),
  send: invoke('draft:send'),
  undoSend: invoke('send:undo'),
  retryOutbox: invoke('outbox:retry'),
  removeOutbox: invoke('outbox:remove'),
  listAudit: invoke('audit:list'),
  saveAttachment: invoke('attachment:save'),
  pickFiles: invoke('compose:pickFiles'),
  pickImage: invoke('compose:pickImage'),
  onSyncStatus: subscribe('sync:status'),
  onMailChanged: subscribe('mail:changed'),
  onOutboxChanged: subscribe('outbox:changed'),
});
