// Bridges a small, safe native API into the renderer (contextIsolation on).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('horosDesktop', {
  isDesktop: true,
  platform: process.platform,
  versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
  openExternal: (url) => ipcRenderer.invoke('horos:open-external', url),
  showItemInFolder: (p) => ipcRenderer.invoke('horos:show-item', p),
  openPath: (p) => ipcRenderer.invoke('horos:open-path', p),
  notify: (title, body) => ipcRenderer.invoke('horos:notify', title, body),
});