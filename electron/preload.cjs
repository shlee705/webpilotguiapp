const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pilotDesktop', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  close: () => ipcRenderer.send('window:close'),
  openInEdge: (url) => ipcRenderer.invoke('browser:open-edge', url),
  beginOverlay: (sessionId) => ipcRenderer.invoke('overlay:begin', sessionId),
  endOverlay: (sessionId) => ipcRenderer.invoke('overlay:end', sessionId),
  getAiSettings: () => ipcRenderer.invoke('ai:get-settings'),
  getCapture: (id) => ipcRenderer.invoke('capture:get', id),
  refreshReport: (runId) => ipcRenderer.invoke('report:refresh', runId),
  openReport: (id) => ipcRenderer.invoke('report:open', id),
  readReport: (id) => ipcRenderer.invoke('report:read', id),
  saveAiSettings: (settings) => ipcRenderer.invoke('ai:save-settings', settings),
  testAiConnection: (settings) => ipcRenderer.invoke('ai:test-connection', settings),
  getBackendSettings: () => ipcRenderer.invoke('backend:get-settings'),
  saveBackendSettings: (settings) => ipcRenderer.invoke('backend:save-settings', settings),
  testBackendConnection: (settings) => ipcRenderer.invoke('backend:test-connection', settings),
  startAiChat: (request) => ipcRenderer.invoke('ai:start-chat', request),
  cancelAiChat: (requestId) => ipcRenderer.send('ai:cancel-chat', requestId),
  onAiEvent: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('ai:event', handler);
    return () => ipcRenderer.removeListener('ai:event', handler);
  },
  onOverlayStopped: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, details) => listener({ reason: String(details?.reason ?? 'unknown') });
    ipcRenderer.on('overlay:stopped', handler);
    return () => ipcRenderer.removeListener('overlay:stopped', handler);
  },
  onMaximizedChange: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, maximized) => listener(Boolean(maximized));
    ipcRenderer.on('window:maximized-changed', handler);
    return () => ipcRenderer.removeListener('window:maximized-changed', handler);
  },
});
