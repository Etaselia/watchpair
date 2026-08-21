import { randomBytes, randomUUID } from "node:crypto";
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
  protocol,
  shell,
  Tray,
  utilityProcess,
} from "electron";
import electronLog from "electron-log";
import electronUpdater from "electron-updater";
import { createSerialTaskQueue, ownsAgentProcess } from "./agent-lifecycle.mjs";
import {
  estimateStorageAfterCleanup,
  legacyCleanupConfirmationOptions,
  runCleanupWithLegacyConfirmation,
  shouldRefreshStorage,
  summarizeCleanupResult,
} from "./cleanup-operation.mjs";
import {
  deepLinkOrigin,
  isFilesystemRoot,
  normalizeDesktopSettings,
  settingsEnvironment,
  settingsRequireAgentRestart,
} from "./settings.mjs";

const { autoUpdater } = electronUpdater;
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(moduleDirectory, "..");
const TEST_MODE = process.env.WATCHPAIR_TEST_MODE === "1";
const SELF_TEST_REPORT = process.env.WATCHPAIR_SELF_TEST_REPORT || "";
const SELF_TEST_RUN_ID = process.env.WATCHPAIR_SELF_TEST_RUN_ID || "";
if (process.env.WATCHPAIR_TEST_USER_DATA) {
  app.setPath("userData", path.resolve(process.env.WATCHPAIR_TEST_USER_DATA));
}
const LOG_DIRECTORY = path.join(app.getPath("userData"), "logs");
const MAIN_LOG_PATH = path.join(LOG_DIRECTORY, "watchpair-main.log");
const AGENT_LOG_FILE = "watchpair-agent.log";
electronLog.transports.file.resolvePathFn = () => MAIN_LOG_PATH;
electronLog.transports.file.maxSize = 5 * 1024 * 1024;
electronLog.transports.file.level = "info";
const AGENT_PORT = Number(process.env.WATCHPAIR_AGENT_PORT || 41735);
const AGENT_URL = "http://127.0.0.1:" + AGENT_PORT;
const CONTROL_TOKEN = randomBytes(32).toString("hex");
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LIBRARY_FILE_ID_PATTERN = /^[a-f0-9]{24}$/;
const PREVIEW_JOB_ID_PATTERN = /^preview-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HLS_ASSET_PATTERN = /^(?:master\.m3u8|video\/(?:index\.m3u8|epoch-\d{6}-(?:init\.mp4|segment-\d{6}\.m4s))|audio\/\d+\/(?:index\.m3u8|epoch-\d{6}-(?:init\.mp4|segment-\d{6}\.m4s)))$/;
const RAW_PREVIEW_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);

protocol.registerSchemesAsPrivileged([{
  scheme: "watchpair-media",
  privileges: {
    standard: true,
    secure: true,
    stream: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}]);

let mainWindow = null;
let tray = null;
let agentProcess = null;
let agentRestartTimer = null;
let updateTimer = null;
let updateCheckTimer = null;
const runAgentTransition = createSerialTaskQueue();
let rendererReady = Promise.resolve();
let quitting = false;
let restartingAgent = false;
let pendingDeepLink = process.argv.find((argument) => argument.startsWith("watchpair://")) || null;
let settings;
let agentState = { status: "starting", error: null, health: null, storage: null };
let updateState = { status: "idle", version: null, percent: 0, error: null };
let lastStorageRefreshAt = 0;
let lastStorageRefreshAttemptAt = 0;
let storageRevision = 0;
let lastAgentDiagnosticStatus = null;
let agentRefreshPromise = null;
const libraryPreviewsBySender = new Map();
const libraryPreviewsBySource = new Map();
let libraryPreviewTransition = Promise.resolve();

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
    logging: {
      directory: LOG_DIRECTORY,
      mainFile: path.basename(MAIN_LOG_PATH),
      agentFile: AGENT_LOG_FILE,
    },
  };
}

async function agentFetch(route, init = {}) {
  const { timeoutMs = 5_000, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  const startedAt = Date.now();
  try {
    const response = await fetch(AGENT_URL + route, {
      ...requestInit,
      headers,
      signal: requestInit.signal || AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Companion returned ${response.status}.`);
    return data;
  } finally {
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 2_000) electronLog.warn("Slow agent response", { route, durationMs });
  }
}

async function refreshAgentStateNow({ forceStorage = false } = {}) {
  const startedAt = Date.now();
  try {
    const refreshStorage = shouldRefreshStorage({
      force: forceStorage,
      hasStorage: Boolean(agentState.storage),
      lastSuccessfulAt: lastStorageRefreshAt,
      lastAttemptAt: lastStorageRefreshAttemptAt,
      now: startedAt,
    });
    if (refreshStorage) lastStorageRefreshAttemptAt = startedAt;
    const storageRequest = refreshStorage
      ? agentFetch("/storage")
        .then((value) => ({ value, error: null }))
        .catch((error) => ({ value: agentState.storage, error }))
      : Promise.resolve({ value: agentState.storage, error: null });
    const [health, storageResult] = await Promise.all([
      agentFetch("/health"),
      storageRequest,
    ]);
    if (storageResult.error) electronLog.warn("Storage diagnostics refresh failed", storageResult.error);
    else if (refreshStorage) {
      lastStorageRefreshAt = Date.now();
      storageRevision += 1;
    }
    agentState = { status: "ready", error: null, health, storage: storageResult.value };
  } catch (error) {
    agentState = {
      ...agentState,
      status: agentProcess ? "starting" : "stopped",
      error: error instanceof Error ? error.message : "Companion is unavailable.",
    };
  }
  const diagnosticStatus = `${agentState.status}:${agentState.error || ""}`;
  if (diagnosticStatus !== lastAgentDiagnosticStatus) {
    const details = {
      status: agentState.status,
      error: agentState.error,
      responseMs: Date.now() - startedAt,
      media: agentState.health?.media || null,
    };
    if (agentState.status === "ready") electronLog.info("Agent connection ready", details);
    else electronLog.warn("Agent connection changed", details);
    lastAgentDiagnosticStatus = diagnosticStatus;
  }
  sendState();
  return agentState;
}

function applyCleanupResult(result, startedRevision) {
  const storage = estimateStorageAfterCleanup(agentState.storage, result, {
    currentRevision: storageRevision,
    startedRevision,
  });
  if (storage === agentState.storage) return;
  agentState = {
    ...agentState,
    storage,
  };
  storageRevision += 1;
}

function refreshAgentState(options = {}) {
  if (agentRefreshPromise) {
    return agentRefreshPromise.then(() =>
      options.forceStorage ? refreshAgentState(options) : agentState
    );
  }
  agentRefreshPromise = refreshAgentStateNow(options).finally(() => {
    agentRefreshPromise = null;
  });
  return agentRefreshPromise;
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

function safeAgentFatalReport(report) {
  try {
    const parsed = JSON.parse(report);
    const header = parsed.header || {};
    return {
      header: {
        reportVersion: header.reportVersion,
        event: header.event,
        trigger: header.trigger,
        dumpEventTime: header.dumpEventTime,
        dumpEventTimeStamp: header.dumpEventTimeStamp,
        processId: header.processId,
        componentVersions: header.componentVersions,
        osName: header.osName,
        osRelease: header.osRelease,
        osVersion: header.osVersion,
        arch: header.arch,
      },
      javascriptStack: parsed.javascriptStack,
      nativeStack: parsed.nativeStack,
      javascriptHeap: parsed.javascriptHeap,
      resourceUsage: parsed.resourceUsage,
      uvthreadResourceUsage: parsed.uvthreadResourceUsage,
      libuv: parsed.libuv,
      workers: parsed.workers,
    };
  } catch (error) {
    return {
      parseError: error instanceof Error ? error.message : String(error),
      reportBytes: Buffer.byteLength(String(report || "")),
    };
  }
}

async function persistAgentFatalReport(type, location, report) {
  try {
    await mkdir(LOG_DIRECTORY, { recursive: true });
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const reportPath = path.join(LOG_DIRECTORY, `watchpair-agent-fatal-${timestamp}.json`);
    await writeFile(reportPath, JSON.stringify({ type, location, report: safeAgentFatalReport(report) }, null, 2));
    electronLog.error("Companion agent fatal report saved", { type, location, reportPath });
  } catch (error) {
    electronLog.error("Could not save companion agent fatal report", error);
  }
}

async function stopAgentNow() {
  if (agentRestartTimer) clearTimeout(agentRestartTimer);
  agentRestartTimer = null;
  const processToStop = agentProcess;
  agentProcess = null;
  if (!processToStop) return;
  electronLog.info("Stopping companion agent", { pid: processToStop.pid });
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
      if (!settled) {
        electronLog.warn("Companion agent did not stop within eight seconds; terminating it", { pid: processToStop.pid });
        processToStop.kill();
      }
      finish();
    }, 8_000).unref?.();
  });
}

async function startAgentNow() {
  await stopAgentNow();
  agentState = { status: "starting", error: null, health: null, storage: null };
  lastStorageRefreshAt = 0;
  lastStorageRefreshAttemptAt = 0;
  storageRevision += 1;
  sendState();
  const serverPath = path.join(applicationRoot, "agent", "server.mjs");
  electronLog.info("Starting companion agent", { port: AGENT_PORT, logFile: AGENT_LOG_FILE });
  const spawnedAgent = utilityProcess.fork(serverPath, [], {
    cwd: app.getPath("userData"),
    env: {
      ...process.env,
      ...settingsEnvironment(settings),
      WATCHPAIR_APP_VERSION: app.getVersion(),
      WATCHPAIR_CONFIG_PATH: path.join(app.getPath("userData"), "agent.json"),
      WATCHPAIR_CONTROL_TOKEN: CONTROL_TOKEN,
      WATCHPAIR_FFPROBE_PATH: packagedFfprobePath(),
      WATCHPAIR_LOG_DIR: LOG_DIRECTORY,
      WATCHPAIR_LOG_FILE: AGENT_LOG_FILE,
    },
    stdio: "pipe",
    serviceName: "WatchPair Companion Agent",
  });
  agentProcess = spawnedAgent;
  spawnedAgent.stdout?.on("data", (chunk) => {
    const message = String(chunk).trimEnd();
    if (message) electronLog.info("[agent]", message);
  });
  spawnedAgent.stderr?.on("data", (chunk) => {
    const message = String(chunk).trimEnd();
    if (message) electronLog.error("[agent]", message);
  });
  spawnedAgent.on("error", (type, location, report) => {
    electronLog.error("Companion agent fatal utility-process error", { type, location, pid: spawnedAgent.pid });
    void persistAgentFatalReport(type, location, report);
  });
  spawnedAgent.once("exit", (code) => {
    const owned = ownsAgentProcess(agentProcess, spawnedAgent);
    const expected = !owned || quitting || restartingAgent;
    const details = { code, pid: spawnedAgent.pid, expected, quitting, restartingAgent };
    if (expected) electronLog.info("Companion agent exited", details);
    else electronLog.error("Companion agent exited unexpectedly", details);
    if (!owned) return;
    agentProcess = null;
    agentState = { ...agentState, status: "stopped", error: `Companion service exited (${code}).` };
    sendState();
    if (!quitting && !restartingAgent) {
      electronLog.warn("Scheduling companion agent restart", { delayMs: 3_000 });
      agentRestartTimer = setTimeout(() => void startAgent(), 3_000);
    }
  });
  try {
    await waitForAgent();
  } catch (error) {
    electronLog.error("Companion agent did not become healthy", error);
    agentState = { ...agentState, status: "error", error: error.message };
    sendState();
  }
}

function startAgent() {
  return runAgentTransition(startAgentNow);
}

function stopAgent() {
  return runAgentTransition(stopAgentNow);
}

async function restartAgent() {
  await runAgentTransition(async () => {
    restartingAgent = true;
    try {
      await stopAgentNow();
    } finally {
      restartingAgent = false;
    }
    await startAgentNow();
  });
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
  const rendererId = mainWindow.webContents.id;
  mainWindow.on("close", (event) => {
    void releaseLibraryPreviewForSender(rendererId);
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
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    electronLog.error("Companion renderer process exited", details);
    void releaseLibraryPreviewForSender(rendererId);
  });
  mainWindow.webContents.once("destroyed", () => void releaseLibraryPreviewForSender(rendererId));
  mainWindow.on("unresponsive", () => electronLog.warn("Companion window became unresponsive"));
  mainWindow.on("responsive", () => electronLog.info("Companion window became responsive again"));
  return mainWindow;
}

function createTray() {
  const icon = nativeImage.createFromPath(windowIcon()).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip("WatchPair Companion");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open WatchPair Companion", click: () => createWindow() },
    { label: "Open downloads", click: () => void shell.openPath(settings.downloadDirectory) },
    { label: "Open logs", click: () => void shell.openPath(LOG_DIRECTORY) },
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
    document.querySelector("#resource-mode").value = "eco";
    document.querySelector("#download-days").value = "14";
    document.querySelector("#cache-days").value = "3";
    document.querySelector("#max-storage").value = "12";
    document.querySelector("#min-free-space").value = "1";
    document.querySelector("#save-settings").click();
  })()`);
  await waitForRenderer("document.querySelector('#message')?.textContent === 'Settings saved'");
  const saved = await mainWindow.webContents.executeJavaScript("window.watchpair.getState()");

  await mainWindow.webContents.executeJavaScript("document.querySelector('#cleanup-now').click()");
  await waitForRenderer("document.querySelector('#message')?.textContent === 'Cleanup complete — nothing eligible'");
  const cleanupMessage = await mainWindow.webContents.executeJavaScript(
    "document.querySelector('#message')?.textContent"
  );
  const cleaned = await mainWindow.webContents.executeJavaScript("window.watchpair.getState()");

  await mainWindow.webContents.executeJavaScript("document.querySelector('#check-update').click()");
  await waitForRenderer("document.querySelector('#update-status')?.textContent === 'Updates are disabled in development'");
  const dom = await mainWindow.webContents.executeJavaScript(`({
    title: document.title,
    status: document.querySelector("#agent-status")?.textContent,
    transcoder: document.querySelector("#active-transcoder")?.textContent,
    resourceMode: document.querySelector("#resource-mode")?.value,
    mediaWork: Boolean(document.querySelector("#media-work")?.textContent),
    update: document.querySelector("#update-status")?.textContent,
    downloadDirectory: document.querySelector("#download-directory")?.value,
    logs: document.querySelector("#log-summary")?.textContent,
    openLogs: Boolean(document.querySelector("#open-logs")),
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
    cleanupMessage,
    dom,
    screenshotPath,
    screenshotSize: image.getSize(),
    screenshotBytes: png.length,
  }, null, 2));
}

function assertMainRenderer(event) {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender.isDestroyed() ||
    event.sender !== mainWindow.webContents
  ) throw new Error("This companion action is only available to the main settings window.");
}

function runLibraryPreviewTransition(task) {
  const result = libraryPreviewTransition.then(task, task);
  libraryPreviewTransition = result.catch(() => {});
  return result;
}

function rawPreviewSupported(name) {
  return RAW_PREVIEW_EXTENSIONS.has(path.extname(String(name || "")).toLowerCase());
}

async function releaseLibraryPreview(record) {
  if (!record) return;
  if (libraryPreviewsBySender.get(record.senderId) === record) {
    libraryPreviewsBySender.delete(record.senderId);
  }
  if (record.sourceId && libraryPreviewsBySource.get(record.sourceId) === record) {
    libraryPreviewsBySource.delete(record.sourceId);
  }
  if (!record.sourceId || record.mode !== "hls") return;
  try {
    await agentFetch(`/downloads/${encodeURIComponent(record.sourceId)}?deleteFiles=0`, {
      method: "DELETE",
      headers: { "x-watchpair-control": CONTROL_TOKEN },
      timeoutMs: 15_000,
    });
  } catch (error) {
    electronLog.warn("Could not release transient library preview", {
      sourceId: record.sourceId,
      error,
    });
  }
}

function releaseLibraryPreviewForSender(senderId) {
  return runLibraryPreviewTransition(() => releaseLibraryPreview(
    libraryPreviewsBySender.get(senderId)
  ));
}

function releaseAllLibraryPreviews() {
  return runLibraryPreviewTransition(async () => {
    for (const record of Array.from(libraryPreviewsBySender.values())) {
      await releaseLibraryPreview(record);
    }
  });
}

function registerRawLibraryPreview(senderId, fileId) {
  const sourceId = `preview-${randomUUID()}`;
  const record = { senderId, fileId, sourceId, mode: "raw" };
  libraryPreviewsBySender.set(senderId, record);
  libraryPreviewsBySource.set(sourceId, record);
  return {
    sourceId,
    mode: record.mode,
    url: `watchpair-media://library/${encodeURIComponent(fileId)}`,
  };
}

async function startLibraryPreview(event, value) {
  assertMainRenderer(event);
  const senderId = event.sender.id;
  const fileId = value?.id;
  const name = String(value?.name || "video").slice(0, 180);
  const forceHls = value?.forceHls === true;
  if (typeof fileId !== "string" || !LIBRARY_FILE_ID_PATTERN.test(fileId)) {
    throw new Error("Invalid library file identifier.");
  }

  return runLibraryPreviewTransition(async () => {
    await releaseLibraryPreview(libraryPreviewsBySender.get(senderId));
    assertMainRenderer(event);
    if (!forceHls && rawPreviewSupported(name)) {
      return registerRawLibraryPreview(senderId, fileId);
    }

    const sourceId = `preview-${randomUUID()}`;
    let attached = false;
    try {
      const result = await agentFetch(`/library/${encodeURIComponent(fileId)}/attach`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-watchpair-control": CONTROL_TOKEN,
        },
        body: JSON.stringify({ sourceId, label: name }),
        timeoutMs: 30_000,
      });
      attached = true;
      assertMainRenderer(event);
      if (result?.job?.id !== sourceId) throw new Error("The companion returned an invalid preview job.");
      const file = result.job.files?.find((candidate) => candidate.selected) || result.job.files?.[0];
      if (!file || !Number.isInteger(file.index) || file.index < 0 || file.index > 10_000) {
        throw new Error("The companion returned an invalid preview file.");
      }
      const record = { senderId, fileId, sourceId, mode: "hls", fileIndex: file.index };
      libraryPreviewsBySender.set(senderId, record);
      libraryPreviewsBySource.set(sourceId, record);
      return {
        sourceId,
        mode: record.mode,
        url: `watchpair-media://hls/${encodeURIComponent(sourceId)}/${file.index}/h264/master.m3u8`,
      };
    } catch (error) {
      if (attached) {
        await releaseLibraryPreview({ senderId, fileId, sourceId, mode: "hls" });
      }
      throw error;
    }
  });
}

async function stopLibraryPreview(event, sourceId) {
  assertMainRenderer(event);
  if (!PREVIEW_JOB_ID_PATTERN.test(String(sourceId || ""))) {
    throw new Error("Invalid library preview identifier.");
  }
  return runLibraryPreviewTransition(async () => {
    const record = libraryPreviewsBySender.get(event.sender.id);
    if (!record) return { ok: true };
    if (record.sourceId !== sourceId) {
      throw new Error("That library preview does not belong to this window.");
    }
    await releaseLibraryPreview(record);
    return { ok: true };
  });
}

function registerIpc() {
  ipcMain.handle("companion:get-state", async () => {
    await refreshAgentState();
    return publicState();
  });
  ipcMain.handle("companion:get-transfers", async (event) => {
    assertMainRenderer(event);
    const result = await agentFetch("/downloads", {
      headers: { "x-watchpair-control": CONTROL_TOKEN },
    });
    return {
      ...result,
      jobs: Array.isArray(result?.jobs)
        ? result.jobs.filter((job) => !PREVIEW_JOB_ID_PATTERN.test(String(job?.id || "")))
        : [],
    };
  });
  ipcMain.handle("companion:get-torrent-details", (event, id) => {
    assertMainRenderer(event);
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) {
      throw new Error("Invalid transfer identifier.");
    }
    return agentFetch(`/downloads/${encodeURIComponent(id)}/torrent`, {
      headers: { "x-watchpair-control": CONTROL_TOKEN },
    });
  });
  ipcMain.handle("companion:get-library", (event, options = {}) => {
    assertMainRenderer(event);
    const query = String(options?.query || "").trim().slice(0, 200);
    const offset = Math.max(0, Math.floor(Number(options?.offset) || 0));
    const limit = Math.max(1, Math.min(200, Math.floor(Number(options?.limit) || 50)));
    const search = new URLSearchParams({ query, offset: String(offset), limit: String(limit) });
    return agentFetch(`/control/library?${search}`, {
      headers: { "x-watchpair-control": CONTROL_TOKEN },
      timeoutMs: 15_000,
    });
  });
  ipcMain.handle("companion:scan-library", (event) => {
    assertMainRenderer(event);
    return agentFetch("/control/library/scan", {
      method: "POST",
      headers: { "x-watchpair-control": CONTROL_TOKEN },
      timeoutMs: 15_000,
    });
  });
  ipcMain.handle("companion:get-library-scan", (event, id) => {
    assertMainRenderer(event);
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(id)) {
      throw new Error("Invalid library scan identifier.");
    }
    return agentFetch(`/control/library/scan?id=${encodeURIComponent(id)}`, {
      headers: { "x-watchpair-control": CONTROL_TOKEN },
    });
  });
  ipcMain.handle("companion:get-library-collection", (event, id) => {
    assertMainRenderer(event);
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/.test(id)) {
      throw new Error("Invalid library collection identifier.");
    }
    return agentFetch(`/control/library/${encodeURIComponent(id)}`, {
      headers: { "x-watchpair-control": CONTROL_TOKEN },
    });
  });
  ipcMain.handle("companion:set-library-pinned", (event, value) => {
    assertMainRenderer(event);
    const id = value?.id;
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/.test(id)) {
      throw new Error("Invalid library collection identifier.");
    }
    return agentFetch(`/control/library/${encodeURIComponent(id)}/pin`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-watchpair-control": CONTROL_TOKEN,
      },
      body: JSON.stringify({ pinned: Boolean(value?.pinned) }),
    });
  });
  ipcMain.handle("companion:start-library-preview", startLibraryPreview);
  ipcMain.handle("companion:stop-library-preview", stopLibraryPreview);
  ipcMain.handle("companion:choose-download-folder", async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "Choose download folder",
      defaultPath: settings.downloadDirectory,
      properties: ["openDirectory", "createDirectory"],
    });
    return selection.canceled ? null : selection.filePaths[0];
  });
  ipcMain.handle("companion:choose-library-folder", async (event) => {
    assertMainRenderer(event);
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "Add library folder",
      defaultPath: settings.libraryDirectories.at(-1) || settings.downloadDirectory,
      properties: ["openDirectory"],
    });
    if (selection.canceled) return null;
    if (isFilesystemRoot(selection.filePaths[0])) {
      throw new Error("Choose a library folder inside the drive or share, not the filesystem root.");
    }
    return selection.filePaths[0];
  });
  ipcMain.handle("companion:save-settings", async (_event, next) => {
    const previousSettings = settings;
    const savedSettings = await saveSettings(next);
    const restartRequired = settingsRequireAgentRestart(previousSettings, savedSettings);
    scheduleUpdater();
    electronLog.info("Companion settings saved", { restartRequired });
    if (restartRequired) await restartAgent();
    else await refreshAgentState();
    return publicState();
  });
  ipcMain.handle("companion:cleanup", async () => {
    const startedStorageRevision = storageRevision;
    const result = await runCleanupWithLegacyConfirmation({
      start: ({ includeLegacy, legacyJobs }) => agentFetch(
        includeLegacy ? "/cleanup?includeLegacy=1" : "/cleanup",
        {
          method: "POST",
          ...(includeLegacy ? {
            headers: {
              "content-type": "application/json",
              "x-watchpair-control": CONTROL_TOKEN,
            },
            body: JSON.stringify({ legacyJobs }),
          } : {}),
        }
      ),
      read: (operationId) => agentFetch(`/cleanup?id=${encodeURIComponent(operationId)}`),
      confirmLegacy: async (_legacyJobs, initialResult) => {
        const options = legacyCleanupConfirmationOptions(initialResult, {
          retentionDays: settings.cleanup.downloadRetentionDays,
        });
        if (!options) return false;
        const answer = await dialog.showMessageBox(mainWindow, options);
        return answer.response === 1;
      },
    });
    applyCleanupResult(result, startedStorageRevision);
    const state = publicState();
    sendState();
    return {
      ...state,
      cleanup: summarizeCleanupResult(result),
    };
  });
  ipcMain.handle("companion:open-downloads", () => shell.openPath(settings.downloadDirectory));
  ipcMain.handle("companion:open-logs", async () => {
    await mkdir(LOG_DIRECTORY, { recursive: true });
    const error = await shell.openPath(LOG_DIRECTORY);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle("companion:check-update", () => checkForUpdates());
  ipcMain.handle("companion:download-update", () => downloadUpdate());
  ipcMain.handle("companion:install-update", () => installUpdate());
}

function mediaProtocolResponse(upstream) {
  const headers = new Headers({
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  });
  for (const name of [
    "accept-ranges",
    "cache-control",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyLibraryPreview(request, route, { range = false } = {}) {
  const headers = new Headers({ "x-watchpair-control": CONTROL_TOKEN });
  const requestedRange = range ? request.headers.get("range") : null;
  if (requestedRange) headers.set("range", requestedRange);
  const upstream = await fetch(AGENT_URL + route, {
    method: request.method,
    headers,
    redirect: "error",
    signal: request.signal,
  });
  return mediaProtocolResponse(upstream);
}

function rawLibraryPreviewRoute(url) {
  if (url.hostname !== "library" || url.search || url.hash) return null;
  const fileId = url.pathname.replace(/^\//u, "");
  if (!LIBRARY_FILE_ID_PATTERN.test(fileId)) return null;
  const active = Array.from(libraryPreviewsBySender.values()).some((record) =>
    record.mode === "raw" && record.fileId === fileId
  );
  return active ? `/library/${encodeURIComponent(fileId)}/preview` : null;
}

function hlsLibraryPreviewRoute(url) {
  if (url.hostname !== "hls" || url.hash) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 5) return null;
  const [sourceId, fileIndexValue, rendition, ...assetParts] = parts;
  const record = libraryPreviewsBySource.get(sourceId);
  const fileIndex = Number(fileIndexValue);
  const asset = assetParts.join("/");
  if (
    !record ||
    !PREVIEW_JOB_ID_PATTERN.test(sourceId) ||
    rendition !== "h264" ||
    !Number.isInteger(fileIndex) ||
    fileIndex !== record.fileIndex ||
    !HLS_ASSET_PATTERN.test(asset)
  ) return null;
  const parameters = new URLSearchParams(url.search);
  const audio = parameters.get("audio");
  if (Array.from(parameters.keys()).some((name) => name !== "audio")) return null;
  if (audio !== null && !["stereo", "surround"].includes(audio)) return null;
  const query = audio ? `?audio=${encodeURIComponent(audio)}` : "";
  return `/hls/${encodeURIComponent(sourceId)}/${fileIndex}/h264/${asset}${query}`;
}

function registerLibraryPreviewProtocol() {
  protocol.handle("watchpair-media", async (request) => {
    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const url = new URL(request.url);
      const rawRoute = rawLibraryPreviewRoute(url);
      if (rawRoute) return proxyLibraryPreview(request, rawRoute, { range: true });
      const hlsRoute = hlsLibraryPreviewRoute(url);
      if (hlsRoute) return proxyLibraryPreview(request, hlsRoute);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error?.name !== "AbortError") electronLog.warn("Library preview proxy failed", error);
      return new Response("Library preview unavailable", { status: 502 });
    }
  });
}

app.on("child-process-gone", (_event, details) => {
  electronLog.error("Electron child process exited", details);
});
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
    void releaseAllLibraryPreviews()
      .finally(() => stopAgent())
      .finally(() => app.quit());
  }
});

async function initialize() {
  if (TEST_MODE) console.error("WatchPair self-test: Electron ready");
  await mkdir(LOG_DIRECTORY, { recursive: true });
  electronLog.initialize();
  electronLog.errorHandler.startCatching({ showDialog: false });
  electronLog.info("WatchPair Companion initialized", {
    version: app.getVersion(),
    platform: process.platform,
    architecture: process.arch,
    electron: process.versions.electron,
    node: process.version,
    packaged: app.isPackaged,
    logFile: MAIN_LOG_PATH,
  });
  await loadSettings();
  app.setAboutPanelOptions({
    applicationName: "WatchPair Companion",
    applicationVersion: app.getVersion(),
    website: "https://github.com/Etaselia/WatchPair",
    iconPath: windowIcon(),
  });
  if (!TEST_MODE) registerProtocol();
  registerLibraryPreviewProtocol();
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
