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
  createProject: invoke('project:create'),
  deleteProject: invoke('project:delete'),
  addAccount: invoke('account:add'),
  deleteAccount: invoke('account:delete'),
  syncAccount: invoke('account:sync'),
  syncAll: invoke('sync:all'),
  listMessages: invoke('messages:list'),
  openMessage: invoke('message:open'),
  markRead: invoke('message:read'),
  deleteMessage: invoke('message:delete'),
  trustImages: invoke('images:trust'),
  saveDraft: invoke('draft:save'),
  getDraft: invoke('draft:get'),
  deleteDraft: invoke('draft:delete'),
  approveAndSend: invoke('draft:approveSend'),
  retryOutbox: invoke('outbox:retry'),
  removeOutbox: invoke('outbox:remove'),
  listAudit: invoke('audit:list'),
  saveAttachment: invoke('attachment:save'),
  pickFiles: invoke('compose:pickFiles'),
  onSyncStatus: subscribe('sync:status'),
  onMailChanged: subscribe('mail:changed'),
  onOutboxChanged: subscribe('outbox:changed'),
});
