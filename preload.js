const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', (msg) => ipcRenderer.invoke('api', msg));
