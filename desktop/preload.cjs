/* eslint-disable @typescript-eslint/no-require-imports -- Electron sandbox preloads use CommonJS. */
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, value) => ipcRenderer.invoke(channel, value);

contextBridge.exposeInMainWorld("watchpair", {
  getState: () => invoke("companion:get-state"),
  getTransfers: () => invoke("companion:get-transfers"),
  getTorrentDetails: (id) => invoke("companion:get-torrent-details", id),
  getLibrary: (options) => invoke("companion:get-library", options),
  scanLibrary: () => invoke("companion:scan-library"),
  getLibraryScan: (id) => invoke("companion:get-library-scan", id),
  getLibraryCollection: (id) => invoke("companion:get-library-collection", id),
  setLibraryPinned: (id, pinned) => invoke("companion:set-library-pinned", { id, pinned }),
  startLibraryPreview: (id, name, forceHls = false) => invoke(
    "companion:start-library-preview",
    { id, name, forceHls }
  ),
  stopLibraryPreview: (sourceId) => invoke("companion:stop-library-preview", sourceId),
  chooseDownloadFolder: () => invoke("companion:choose-download-folder"),
  chooseLibraryFolder: () => invoke("companion:choose-library-folder"),
  saveSettings: (settings) => invoke("companion:save-settings", settings),
  cleanup: () => invoke("companion:cleanup"),
  openDownloads: () => invoke("companion:open-downloads"),
  openLogs: () => invoke("companion:open-logs"),
  checkForUpdates: () => invoke("companion:check-update"),
  downloadUpdate: () => invoke("companion:download-update"),
  installUpdate: () => invoke("companion:install-update"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("companion:state", listener);
    return () => ipcRenderer.removeListener("companion:state", listener);
  },
});
