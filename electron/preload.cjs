const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('emargy', {
  getState: () => ipcRenderer.invoke('state:get'),
  setLanguage: (language) => ipcRenderer.invoke('settings:language', language),
  createProject: (input) => ipcRenderer.invoke('project:create', input),
  deleteProject: (id) => ipcRenderer.invoke('project:delete', id),
  addAccount: (input) => ipcRenderer.invoke('account:add', input),
  deleteAccount: (id) => ipcRenderer.invoke('account:delete', id),
  syncAccount: (id) => ipcRenderer.invoke('account:sync', id),
  getMessage: (id) => ipcRenderer.invoke('message:get', id),
  markRead: (id, read) => ipcRenderer.invoke('message:read', { id, read }),
  saveDraft: (draft) => ipcRenderer.invoke('draft:save', draft),
  deleteDraft: (id) => ipcRenderer.invoke('draft:delete', id),
  sendDraft: (id) => ipcRenderer.invoke('draft:send', id),
  saveAttachment: (attachment) => ipcRenderer.invoke('attachment:save', attachment),
  onSyncStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sync:status', listener);
    return () => ipcRenderer.removeListener('sync:status', listener);
  },
});

