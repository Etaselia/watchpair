/* eslint-disable @typescript-eslint/no-require-imports -- Electron sandbox preloads use CommonJS. */
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, value) => ipcRenderer.invoke(channel, value);

contextBridge.exposeInMainWorld("watchpair", {
  getState: () => invoke("companion:get-state"),
  chooseDownloadFolder: () => invoke("companion:choose-download-folder"),
  saveSettings: (settings) => invoke("companion:save-settings", settings),
  cleanup: () => invoke("companion:cleanup"),
  openDownloads: () => invoke("companion:open-downloads"),
  checkForUpdates: () => invoke("companion:check-update"),
  downloadUpdate: () => invoke("companion:download-update"),
  installUpdate: () => invoke("companion:install-update"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("companion:state", listener);
    return () => ipcRenderer.removeListener("companion:state", listener);
  },
});
