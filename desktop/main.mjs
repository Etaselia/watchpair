import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  utilityProcess,
} from "electron";
import electronLog from "electron-log";
import electronUpdater from "electron-updater";
import { deepLinkOrigin, normalizeDesktopSettings, settingsEnvironment } from "./settings.mjs";

const { autoUpdater } = electronUpdater;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(moduleDirectory, "..");
const TEST_MODE = process.env.WATCHPAIR_TEST_MODE === "1";
const SELF_TEST_REPORT = process.env.WATCHPAIR_SELF_TEST_REPORT || "";
const SELF_TEST_RUN_ID = process.env.WATCHPAIR_SELF_TEST_RUN_ID || "";
if (process.env.WATCHPAIR_TEST_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.WATCHPAIR_TEST_USER_DATA));
}
const AGENT_PORT = Number(process.env.WATCHPAIR_AGENT_PORT || 41735);
const AGENT_URL = "http://127.0.0.1:" + AGENT_PORT;
const CONTROL_TOKEN = randomBytes(32).toString("hex");
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let mainWindow = null;
let tray = null;
let agentProcess = null;
let agentRestartTimer = null;
let updateTimer = null;
let updateCheckTimer = null;
let rendererReady = Promise.resolve();
let quitting = false;
let restartingAgent = false;
let pendingDeepLink = process.argv.find((argument) => argument.startsWith("watchpair://")) || null;
let settings;
let agentState = { status: "starting", error: null, health: null, storage: null };
let updateState = { status: "idle", version: null, percent: 0, error: null };

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

function defaultDownloadDirectory() {
  return path.join(app.getPath("downloads"), "WatchPair");
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

async function loadSettings() {
  let value = {};
  try {
    value = JSON.parse(await readFile(settingsPath(), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") electronLog.warn("Could not read settings", error);
  }
  settings = normalizeDesktopSettings(value, { defaultDownloadDirectory: defaultDownloadDirectory() });
  return settings;
}

async function saveSettings(next) {
  settings = normalizeDesktopSettings(next, { defaultDownloadDirectory: defaultDownloadDirectory() });
  const temporary = settingsPath() + ".tmp";
  await writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(temporary, settingsPath());
  if (!TEST_MODE) app.setLoginItemSettings({ openAtLogin: settings.startAtLogin });
  return settings;
}

function sendState() {
  const value = publicState();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("companion:state", value);
}

function publicState() {
  return {
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    settings,
    agent: agentState,
    update: updateState,
  };
}

async function agentFetch(route, init = {}) {
  const headers = new Headers(init.headers);
  const response = await fetch(AGENT_URL + route, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Companion returned ${response.status}.`);
  return data;
}

async function refreshAgentState() {
  try {
    const [health, storage] = await Promise.all([
      agentFetch("/health"),
      agentFetch("/storage"),
    ]);
    agentState = { status: "ready", error: null, health, storage };
  } catch (error) {
    agentState = {
      ...agentState,
      status: agentProcess ? "starting" : "stopped",
      error: error instanceof Error ? error.message : "Companion is unavailable.",
    };
  }
  sendState();
  return agentState;
}

async function waitForAgent(timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await agentFetch("/health");
      return refreshAgentState();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("The companion service did not start in time.");
}

async function stopAgent() {
  if (agentRestartTimer) clearTimeout(agentRestartTimer);
  agentRestartTimer = null;
  const processToStop = agentProcess;
  agentProcess = null;
  if (!processToStop) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    processToStop.once("exit", finish);
    processToStop.postMessage("shutdown");
    setTimeout(() => {
      if (!settled) processToStop.kill();
      finish();
    }, 8_000).unref?.();
  });
}

async function startAgent() {
  await stopAgent();
  agentState = { status: "starting", error: null, health: null, storage: null };
  sendState();
  const serverPath = path.join(applicationRoot, "agent", "server.mjs");
  agentProcess = utilityProcess.fork(serverPath, [], {
    cwd: applicationRoot,
    env: {
      ...process.env,
      ...settingsEnvironment(settings),
      WATCHPAIR_APP_VERSION: app.getVersion(),
      WATCHPAIR_CONFIG_PATH: path.join(app.getPath("userData"), "agent.json"),
      WATCHPAIR_CONTROL_TOKEN: CONTROL_TOKEN,
      WATCHPAIR_FFPROBE_PATH: packagedFfprobePath(),
    },
    stdio: "pipe",
    serviceName: "WatchPair Companion Agent",
  });
  agentProcess.stdout?.on("data", (chunk) => electronLog.info(String(chunk).trimEnd()));
  agentProcess.stderr?.on("data", (chunk) => electronLog.error(String(chunk).trimEnd()));
  agentProcess.once("exit", (code) => {
    agentProcess = null;
    agentState = { ...agentState, status: "stopped", error: `Companion service exited (${code}).` };
    sendState();
    if (!quitting && !restartingAgent) {
      agentRestartTimer = setTimeout(() => void startAgent(), 3_000);
    }
  });
  try {
    await waitForAgent();
  } catch (error) {
    agentState = { ...agentState, status: "error", error: error.message };
    sendState();
  }
}

async function restartAgent() {
  restartingAgent = true;
  try {
    await stopAgent();
  } finally {
    restartingAgent = false;
  }
  await startAgent();
  if (TEST_MODE) console.error("WatchPair self-test: agent startup finished", agentState.status);
}

function packagedFfprobePath() {
  if (!app.isPackaged) return process.env.WATCHPAIR_FFPROBE_PATH || "";
  return path.join(process.resourcesPath, "ffprobe", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
}

function windowIcon() {
  return path.join(applicationRoot, "build", "icon.png");
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 780,
    height: 760,
    minWidth: 650,
    minHeight: 620,
    backgroundColor: "#10130f",
    icon: windowIcon(),
    show: false,
    title: "WatchPair Companion",
    webPreferences: {
      preload: path.join(moduleDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  rendererReady = mainWindow.loadFile(path.join(moduleDirectory, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", (event) => {
    if (TEST_MODE) {
      quitting = true;
      return;
    }
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  return mainWindow;
}

function createTray() {
  const icon = nativeImage.createFromPath(windowIcon()).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip("WatchPair Companion");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open WatchPair Companion", click: () => createWindow() },
    { label: "Open downloads", click: () => void shell.openPath(settings.downloadDirectory) },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => createWindow());
}

async function pairOriginFromLink(link) {
  try {
    const origin = deepLinkOrigin(link);
    createWindow();
    const answer = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "Connect WatchPair",
      message: "Connect this website to WatchPair Companion?",
      detail: origin,
      buttons: ["Connect", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response !== 0) return false;
    await waitForAgent();
    await agentFetch("/control/pair", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-watchpair-control": CONTROL_TOKEN,
      },
      body: JSON.stringify({ origin }),
    });
    await refreshAgentState();
    return true;
  } catch (error) {
    createWindow();
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Could not connect WatchPair",
      message: error instanceof Error ? error.message : "The connection request was invalid.",
    });
    return false;
  }
}

function registerProtocol() {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient("watchpair", process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("watchpair");
  }
}

function configureUpdater() {
  autoUpdater.logger = electronLog;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  const update = (next) => {
    updateState = { ...updateState, ...next };
    sendState();
  };
  autoUpdater.on("checking-for-update", () => update({ status: "checking", error: null, percent: 0 }));
  autoUpdater.on("update-available", (info) => {
    update({ status: "available", version: info.version, error: null });
    if (settings.updates.automaticDownloads) void downloadUpdate();
  });
  autoUpdater.on("update-not-available", () => update({ status: "current", version: null, error: null }));
  autoUpdater.on("download-progress", (progress) => update({ status: "downloading", percent: progress.percent }));
  autoUpdater.on("update-downloaded", (info) => update({ status: "ready", version: info.version, percent: 100 }));
  autoUpdater.on("error", (error) => update({ status: "error", error: error.message }));

  scheduleUpdater();
}

function scheduleUpdater() {
  if (updateTimer) clearInterval(updateTimer);
  if (updateCheckTimer) clearTimeout(updateCheckTimer);
  updateTimer = null;
  updateCheckTimer = null;
  if (!settings.updates.automaticChecks) return;
  updateCheckTimer = setTimeout(() => void checkForUpdates(), 30_000);
  updateCheckTimer.unref?.();
  updateTimer = setInterval(() => void checkForUpdates(), UPDATE_INTERVAL_MS);
  updateTimer.unref?.();
}

async function checkForUpdates() {
  if (!app.isPackaged || TEST_MODE) {
    updateState = { status: "development", version: null, percent: 0, error: null };
    sendState();
    return updateState;
  }
  await autoUpdater.checkForUpdates();
  return updateState;
}

async function downloadUpdate() {
  if (!app.isPackaged) return checkForUpdates();
  updateState = { ...updateState, status: "downloading", error: null };
  sendState();
  await autoUpdater.downloadUpdate();
  return updateState;
}

async function installUpdate() {
  if (updateState.status !== "ready") throw new Error("No downloaded update is ready to install.");
  quitting = true;
  await stopAgent();
  autoUpdater.quitAndInstall(false, true);
}

async function waitForRenderer(expression, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await mainWindow.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Renderer condition timed out: ${expression}`);
}

async function runSelfTest() {
  if (!SELF_TEST_REPORT) return;
  await rendererReady;
  await waitForRenderer("window.watchpair && document.querySelector('#save-settings')");
  const initial = await mainWindow.webContents.executeJavaScript("window.watchpair.getState()");
  const downloadDirectory = path.resolve(process.env.WATCHPAIR_TEST_DOWNLOAD_DIR);
  await mainWindow.webContents.executeJavaScript(`(() => {
    document.querySelector("#download-directory").value = ${JSON.stringify(downloadDirectory)};
    document.querySelector("#transcoder").value = "cpu";
    document.querySelector("#download-days").value = "14";
    document.querySelector("#cache-days").value = "3";
    document.querySelector("#max-storage").value = "12";
    document.querySelector("#min-free-space").value = "1";
    document.querySelector("#save-settings").click();
  })()`);
  await waitForRenderer("document.querySelector('#message')?.textContent === 'Settings saved'");
  const saved = await mainWindow.webContents.executeJavaScript("window.watchpair.getState()");

  await mainWindow.webContents.executeJavaScript("document.querySelector('#cleanup-now').click()");
  await waitForRenderer("document.querySelector('#message')?.textContent === 'Cleanup complete'");
  const cleaned = await mainWindow.webContents.executeJavaScript("window.watchpair.getState()");

  await mainWindow.webContents.executeJavaScript("document.querySelector('#check-update').click()");
  await waitForRenderer("document.querySelector('#update-status')?.textContent === 'Updates are disabled in development'");
  const dom = await mainWindow.webContents.executeJavaScript(`({
    title: document.title,
    status: document.querySelector("#agent-status")?.textContent,
    transcoder: document.querySelector("#active-transcoder")?.textContent,
    update: document.querySelector("#update-status")?.textContent,
    downloadDirectory: document.querySelector("#download-directory")?.value,
    sections: document.querySelectorAll("main section").length
  })`);
  const image = await mainWindow.webContents.capturePage();
  const screenshotPath = path.join(path.dirname(SELF_TEST_REPORT), "desktop-companion.png");
  const png = image.toPNG();
  await mkdir(path.dirname(SELF_TEST_REPORT), { recursive: true });
  await writeFile(screenshotPath, png);
  await writeFile(SELF_TEST_REPORT, JSON.stringify({
    runId: SELF_TEST_RUN_ID,
    initial,
    saved,
    cleaned,
    dom,
    screenshotPath,
    screenshotSize: image.getSize(),
    screenshotBytes: png.length,
  }, null, 2));
}

function registerIpc() {
  ipcMain.handle("companion:get-state", async () => {
    await refreshAgentState();
    return publicState();
  });
  ipcMain.handle("companion:choose-download-folder", async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "Choose download folder",
      defaultPath: settings.downloadDirectory,
      properties: ["openDirectory", "createDirectory"],
    });
    return selection.canceled ? null : selection.filePaths[0];
  });
  ipcMain.handle("companion:save-settings", async (_event, next) => {
    await saveSettings(next);
    scheduleUpdater();
    await restartAgent();
    return publicState();
  });
  ipcMain.handle("companion:cleanup", async () => {
    await agentFetch("/cleanup", { method: "POST" });
    await refreshAgentState();
    return publicState();
  });
  ipcMain.handle("companion:open-downloads", () => shell.openPath(settings.downloadDirectory));
  ipcMain.handle("companion:check-update", () => checkForUpdates());
  ipcMain.handle("companion:download-update", () => downloadUpdate());
  ipcMain.handle("companion:install-update", () => installUpdate());
}

app.on("second-instance", (_event, argv) => {
  const link = argv.find((argument) => argument.startsWith("watchpair://"));
  if (link) void pairOriginFromLink(link);
  else createWindow();
});
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (app.isReady()) void pairOriginFromLink(url);
  else pendingDeepLink = url;
});
app.on("window-all-closed", () => {
  if (TEST_MODE) {
    quitting = true;
    app.quit();
  }
});
app.on("before-quit", (event) => {
  quitting = true;
  if (agentProcess) {
    event.preventDefault();
    void stopAgent().finally(() => app.quit());
  }
});

async function initialize() {
  if (TEST_MODE) console.error("WatchPair self-test: Electron ready");
  electronLog.initialize();
  await loadSettings();
  app.setAboutPanelOptions({
    applicationName: "WatchPair Companion",
    applicationVersion: app.getVersion(),
    website: "https://github.com/Etaselia/WatchPair",
    iconPath: windowIcon(),
  });
  if (!TEST_MODE) registerProtocol();
  registerIpc();
  createWindow();
  if (!TEST_MODE) createTray();
  await startAgent();
  configureUpdater();
  if (SELF_TEST_REPORT) {
    let exitCode = 0;
    try {
      await runSelfTest();
    } catch (error) {
      exitCode = 1;
      await mkdir(path.dirname(SELF_TEST_REPORT), { recursive: true });
      await writeFile(SELF_TEST_REPORT, JSON.stringify({
        runId: SELF_TEST_RUN_ID,
        error: error instanceof Error ? error.stack || error.message : String(error),
      }, null, 2));
    }
    quitting = true;
    await stopAgent();
    app.exit(exitCode);
  } else {
    if (pendingDeepLink) {
      const link = pendingDeepLink;
      pendingDeepLink = null;
      void pairOriginFromLink(link);
    }
    setInterval(() => void refreshAgentState(), 10_000).unref?.();
  }
}

if (singleInstance) {
  if (TEST_MODE) console.error("WatchPair self-test: waiting for Electron ready");
  void app.whenReady().then(initialize).catch((error) => {
    electronLog.error("WatchPair startup failed", error);
    app.exit(1);
  });
}
