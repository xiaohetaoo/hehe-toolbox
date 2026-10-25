const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('hehe', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (event, cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }
});
