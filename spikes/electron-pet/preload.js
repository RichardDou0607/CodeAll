const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("petAPI", {
  onEvent: (cb) => ipcRenderer.on("pet-event", (_e, payload) => cb(payload)),
  reportState: (payload) => ipcRenderer.invoke("report-state", payload),
  windowDiag: () => ipcRenderer.invoke("window-diag"),
  setClickThrough: (on) => ipcRenderer.invoke("set-click-through", on),
});
