const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFiles'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  getFileStats: (filePath) => ipcRenderer.invoke('file:getStats', filePath),
  cacheRead: (key) => ipcRenderer.invoke('cache:read', key),
  cacheWrite: (key, value) => ipcRenderer.invoke('cache:write', key, value),
  cacheReadAll: () => ipcRenderer.invoke('cache:readAll'),
  waveformRead: (key) => ipcRenderer.invoke('waveform:read', key),
  waveformWrite: (key, bytes) => ipcRenderer.invoke('waveform:write', key, bytes),
  getAudioMetadata: (filePath) => ipcRenderer.invoke('audio:getMetadata', filePath),
  librarySave: (tracks) => ipcRenderer.invoke('library:save', tracks),
  libraryLoad: () => ipcRenderer.invoke('library:load'),
  libraryClear: () => ipcRenderer.invoke('library:clear'),
  reportSave: (report) => ipcRenderer.invoke('report:save', report),
});
