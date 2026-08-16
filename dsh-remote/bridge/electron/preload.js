// preload：向渲染层暴露安全的 IPC 桥
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  getState: () => ipcRenderer.invoke("get-state"),
  login: (payload) => ipcRenderer.invoke("login", payload),
  logout: () => ipcRenderer.invoke("logout"),
  quit: () => ipcRenderer.invoke("quit"),
  generatePairing: () => ipcRenderer.invoke("pairing-generate"),
  onState: (cb) => ipcRenderer.on("state", (_e, state) => cb(state)),
});
