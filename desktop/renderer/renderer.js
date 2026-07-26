const elements = Object.fromEntries(
  [
    "version", "agent-status", "storage-summary", "open-downloads", "download-directory",
    "choose-directory", "cleanup-enabled", "cleanup-now", "download-days", "cache-days",
    "partial-hours", "max-storage", "min-free-space", "transcoder", "resource-mode", "active-transcoder",
    "media-work", "media-pressure", "start-login", "update-status", "check-update", "download-update",
    "log-summary", "open-logs",
    "install-update",
    "automatic-checks", "automatic-downloads", "update-progress", "message", "save-settings",
  ].map((id) => [id, document.getElementById(id)])
);

let busy = false;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function setMessage(message, error = false) {
  elements.message.textContent = message || "";
  elements.message.classList.toggle("error", error);
}

function setBusy(value) {
  busy = value;
  elements["save-settings"].disabled = value;
  elements["cleanup-now"].disabled = value;
  elements["check-update"].disabled = value;
}

function updateLabel(update) {
  const labels = {
    idle: "Not checked yet",
    checking: "Checking for updates",
    current: "WatchPair is up to date",
    available: `Version ${update.version} is available`,
    downloading: `Downloading ${Math.round(update.percent || 0)}%`,
    ready: `Version ${update.version} is ready`,
    development: "Updates are disabled in development",
    error: update.error || "Update check failed",
  };
  return labels[update.status] || update.status;
}

function mediaWorkLabel(media) {
  const scheduler = media?.scheduler;
  const process = media?.activeProcess;
  const queued = scheduler?.queued?.length || 0;
  if (scheduler?.active) {
    const work = process?.encoder || scheduler.active.stage || "Media processing";
    return `${work} · ${scheduler.active.profile}${queued ? ` · ${queued} queued` : ""}`;
  }
  return queued ? `${queued} queued` : "Idle";
}

function mediaPressureLabel(media) {
  const responsiveness = media?.scheduler?.responsiveness;
  if (!responsiveness) return "Measuring";
  const cpu = Number.isFinite(responsiveness.systemCpuPercent)
    ? `${Math.round(responsiveness.systemCpuPercent)}% CPU`
    : null;
  const delay = Number.isFinite(responsiveness.eventLoopDelayP95Ms)
    ? `${Math.round(responsiveness.eventLoopDelayP95Ms)} ms response delay`
    : null;
  return [cpu, delay].filter(Boolean).join(" · ") || "Measuring";
}

function render(next, { populateForm = false } = {}) {
  elements.version.textContent = `Version ${next.version}`;
  elements["agent-status"].textContent = next.agent.status === "ready" ? "Running" : next.agent.status;
  elements["agent-status"].className = `status-pill ${next.agent.status === "ready" ? "ready" : next.agent.status === "error" ? "error" : ""}`;

  const storage = next.agent.storage?.usage;
  elements["storage-summary"].textContent = storage
    ? `${formatBytes(storage.bytes)} used · ${formatBytes(storage.availableBytes)} free · ${storage.pinnedJobs} pinned`
    : next.agent.error || "Reading storage usage";
  elements["active-transcoder"].textContent = next.agent.health?.transcoder?.label || "Starting";
  elements["media-work"].textContent = mediaWorkLabel(next.agent.health?.media);
  elements["media-pressure"].textContent = mediaPressureLabel(next.agent.health?.media);
  elements["log-summary"].textContent = next.logging
    ? `${next.logging.mainFile} · ${next.logging.agentFile}`
    : "Local logs unavailable";
  elements["log-summary"].title = next.logging?.directory || "";

  if (populateForm) {
    const settings = next.settings;
    elements["download-directory"].value = settings.downloadDirectory;
    elements["cleanup-enabled"].checked = settings.cleanup.enabled;
    elements["download-days"].value = settings.cleanup.downloadRetentionDays;
    elements["cache-days"].value = settings.cleanup.cacheRetentionDays;
    elements["partial-hours"].value = settings.cleanup.partialRetentionHours;
    elements["max-storage"].value = settings.cleanup.maxStorageGb;
    elements["min-free-space"].value = settings.cleanup.minFreeSpaceGb;
    elements.transcoder.value = settings.transcoder;
    elements["resource-mode"].value = settings.resourceMode;
    elements["start-login"].checked = settings.startAtLogin;
    elements["automatic-checks"].checked = settings.updates.automaticChecks;
    elements["automatic-downloads"].checked = settings.updates.automaticDownloads;
  }

  const update = next.update;
  elements["update-status"].textContent = updateLabel(update);
  elements["download-update"].classList.toggle("hidden", update.status !== "available");
  elements["install-update"].classList.toggle("hidden", update.status !== "ready");
  elements["update-progress"].classList.toggle("hidden", update.status !== "downloading");
  elements["update-progress"].firstElementChild.style.width = `${Math.max(0, Math.min(100, update.percent || 0))}%`;
}

function formSettings() {
  return {
    downloadDirectory: elements["download-directory"].value,
    startAtLogin: elements["start-login"].checked,
    transcoder: elements.transcoder.value,
    resourceMode: elements["resource-mode"].value,
    cleanup: {
      enabled: elements["cleanup-enabled"].checked,
      downloadRetentionDays: Number(elements["download-days"].value),
      cacheRetentionDays: Number(elements["cache-days"].value),
      partialRetentionHours: Number(elements["partial-hours"].value),
      maxStorageGb: Number(elements["max-storage"].value),
      minFreeSpaceGb: Number(elements["min-free-space"].value),
    },
    updates: {
      automaticChecks: elements["automatic-checks"].checked,
      automaticDownloads: elements["automatic-downloads"].checked,
    },
  };
}

async function action(work, success) {
  if (busy) return;
  setBusy(true);
  setMessage("");
  try {
    const next = await work();
    if (next?.settings) render(next, { populateForm: true });
    setMessage(success || "Done");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "The action failed.", true);
  } finally {
    setBusy(false);
  }
}

elements["choose-directory"].addEventListener("click", async () => {
  const selected = await window.watchpair.chooseDownloadFolder();
  if (selected) elements["download-directory"].value = selected;
});
elements["open-downloads"].addEventListener("click", () => window.watchpair.openDownloads());
elements["open-logs"].addEventListener("click", () => action(
  () => window.watchpair.openLogs(),
  "Logs opened"
));
elements["save-settings"].addEventListener("click", () => action(
  () => window.watchpair.saveSettings(formSettings()),
  "Settings saved"
));
elements["cleanup-now"].addEventListener("click", () => action(
  () => window.watchpair.cleanup(),
  "Cleanup complete"
));
elements["check-update"].addEventListener("click", () => action(
  () => window.watchpair.checkForUpdates(),
  "Update check started"
));
elements["download-update"].addEventListener("click", () => action(
  () => window.watchpair.downloadUpdate(),
  "Update download started"
));
elements["install-update"].addEventListener("click", () => window.watchpair.installUpdate());

window.watchpair.onState((next) => render(next));
window.watchpair.getState()
  .then((next) => render(next, { populateForm: true }))
  .catch((error) => setMessage(error.message, true));
