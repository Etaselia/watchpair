const elements = Object.fromEntries(
  [
    "version", "agent-status", "storage-summary", "open-downloads", "download-directory",
    "choose-directory", "cleanup-enabled", "cleanup-now", "download-days", "cache-days",
    "partial-hours", "max-storage", "min-free-space", "transcoder", "resource-mode", "active-transcoder",
    "media-work", "media-pressure", "start-login", "update-status", "check-update", "download-update",
    "log-summary", "open-logs",
    "install-update",
    "automatic-checks", "automatic-downloads", "update-progress", "message", "save-settings",
    "transfers-summary", "refresh-transfers", "transfer-list", "torrent-details",
    "torrent-details-title", "torrent-details-subtitle", "torrent-details-content", "close-torrent-details",
    "library-summary", "library-folders", "library-search", "library-list", "add-library-folder",
    "scan-library", "library-details", "library-details-title", "library-details-subtitle",
    "library-details-content", "close-library-details",
    "library-previous", "library-page", "library-next",
  ].map((id) => [id, document.getElementById(id)])
);

let busy = false;
let transfers = [];
let selectedTransferId = null;
let transfersRefreshing = false;
let detailsRefreshing = false;
let detailsRefreshQueued = false;
let transferPollTimer = null;
let detailsPollTimer = null;
let libraryCollections = [];
let libraryDirectories = [];
let libraryRefreshing = false;
let libraryRefreshQueued = false;
let libraryRequestGeneration = 0;
let libraryRefreshQueueTimer = null;
let libraryScanTimer = null;
let libraryScanPolling = false;
let activeLibraryScanId = null;
let librarySearchTimer = null;
let selectedLibraryCollectionId = null;
let libraryOffset = 0;
let libraryTotal = 0;
let activeLibraryPreview = null;
let libraryPreviewGeneration = 0;
let hlsRuntimePromise = null;

const TRANSFER_POLL_MS = 5_000;
const DETAILS_POLL_MS = 12_000;
const LIBRARY_SCAN_POLL_MS = 600;
const LIBRARY_PAGE_SIZE = 50;

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

function formatRate(bytes) {
  return Number.isFinite(bytes) ? `${formatBytes(bytes)}/s` : "Unknown";
}

function formatAge(timestamp) {
  if (!Number.isFinite(timestamp)) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function humanize(value) {
  if (!value) return "Unknown";
  return String(value)
    .replaceAll("-", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

function appendText(parent, tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function selectedFile(job) {
  return job.files?.find((file) => file.selected) || job.files?.[0] || null;
}

function transferTitle(job) {
  return selectedFile(job)?.name || job.label || `Transfer ${job.id.slice(0, 8)}`;
}

function torrentSummary(job) {
  return job.torrent || job.torrentTelemetry || null;
}

function trackerSeedersLabel(value) {
  return Number.isFinite(value) ? String(value) : "Unknown";
}

function renderTransfers() {
  elements["transfer-list"].replaceChildren();
  const torrentJobs = transfers.filter((job) => job.kind === "magnet" || job.infoHash || torrentSummary(job));
  elements["transfers-summary"].textContent = transfers.length
    ? `${transfers.length} transfer${transfers.length === 1 ? "" : "s"} · ${torrentJobs.length} torrent${torrentJobs.length === 1 ? "" : "s"}`
    : "No downloads or shared files";

  if (!transfers.length) {
    appendText(elements["transfer-list"], "p", "empty-state", "Transfers will appear here when media is downloaded or shared.");
    return;
  }

  for (const job of transfers) {
    const row = document.createElement("article");
    row.className = "transfer-row";

    const identity = document.createElement("div");
    identity.className = "transfer-identity";
    appendText(identity, "strong", "transfer-name", transferTitle(job));
    const state = [humanize(job.seedState || job.status)];
    if (job.pinned) state.push("Pinned");
    if (job.seed) state.push("Sharing");
    appendText(identity, "span", "transfer-state", state.join(" · "));
    row.append(identity);

    const metrics = document.createElement("div");
    metrics.className = "transfer-metrics";
    const telemetry = torrentSummary(job);
    const peers = telemetry?.connectedPeers ?? job.peers;
    appendText(metrics, "span", "", `${Number.isFinite(peers) ? peers : 0} connected`);
    if (job.kind === "magnet" || job.infoHash || telemetry) {
      appendText(
        metrics,
        "span",
        "",
        `${trackerSeedersLabel(telemetry?.trackerReportedSeeders)} tracker-reported seeds`
      );
    }
    row.append(metrics);

    const progress = document.createElement("div");
    progress.className = "transfer-progress";
    const progressValue = Math.max(0, Math.min(100, Number(job.progress) || 0));
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", `${transferTitle(job)} progress`);
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.setAttribute("aria-valuenow", String(progressValue));
    const progressBar = document.createElement("span");
    progressBar.style.width = `${progressValue}%`;
    progress.append(progressBar);
    row.append(progress);

    const details = document.createElement("button");
    details.type = "button";
    details.className = "secondary transfer-details-button";
    details.textContent = "Torrent details";
    details.disabled = !(job.kind === "magnet" || job.infoHash || telemetry);
    details.addEventListener("click", () => openTorrentDetails(job));
    row.append(details);
    elements["transfer-list"].append(row);
  }
}

async function refreshTransfers() {
  if (transfersRefreshing || document.visibilityState === "hidden") return;
  transfersRefreshing = true;
  elements["refresh-transfers"].disabled = true;
  try {
    const result = await window.watchpair.getTransfers();
    transfers = Array.isArray(result?.jobs) ? result.jobs : [];
    renderTransfers();
  } catch (error) {
    elements["transfers-summary"].textContent = error instanceof Error
      ? error.message
      : "Transfers are unavailable";
  } finally {
    transfersRefreshing = false;
    elements["refresh-transfers"].disabled = false;
  }
}

function detailMetric(parent, label, value) {
  const metric = document.createElement("div");
  metric.className = "torrent-metric";
  appendText(metric, "span", "torrent-metric-label", label);
  appendText(metric, "strong", "torrent-metric-value", value);
  parent.append(metric);
}

function renderTorrentDetails(torrent) {
  const content = elements["torrent-details-content"];
  content.replaceChildren();
  if (!torrent) {
    appendText(content, "p", "empty-state", "Swarm information is not available for this transfer yet.");
    return;
  }

  const metrics = document.createElement("div");
  metrics.className = "torrent-metric-grid";
  detailMetric(metrics, "Connected peers", String(torrent.connectedPeers ?? 0));
  detailMetric(metrics, "Connected seeds", String(torrent.connectedSeeds ?? 0));
  detailMetric(metrics, "Tracker-reported seeds", trackerSeedersLabel(torrent.trackerReportedSeeders));
  detailMetric(
    metrics,
    "Responding trackers",
    `${torrent.respondingTrackers ?? 0} of ${torrent.configuredTrackers ?? 0}`
  );
  content.append(metrics);

  const context = document.createElement("div");
  context.className = "torrent-context";
  appendText(context, "span", "", `Latest tracker response: ${formatAge(torrent.lastTrackerResponseAt)}`);
  if (Number.isFinite(torrent.downloadSpeed)) {
    appendText(context, "span", "", `Download: ${formatRate(torrent.downloadSpeed)}`);
  }
  if (Number.isFinite(torrent.uploadSpeed)) {
    appendText(context, "span", "", `Upload: ${formatRate(torrent.uploadSpeed)}`);
  }
  content.append(context);

  const discovery = document.createElement("div");
  discovery.className = "discovery-row";
  const discoveryModes = [
    ["Tracker", torrent.discovery?.trackerEnabled],
    ["DHT", torrent.discovery?.dhtEnabled],
    ["Local discovery", torrent.discovery?.lsdEnabled],
    ["Peer exchange", torrent.discovery?.peerExchangeEnabled],
  ];
  for (const [label, enabled] of discoveryModes) {
    appendText(discovery, "span", `discovery-pill ${enabled ? "enabled" : ""}`, `${label}: ${enabled ? "On" : "Off"}`);
  }
  content.append(discovery);

  const trackerHeading = document.createElement("div");
  trackerHeading.className = "tracker-heading";
  appendText(trackerHeading, "h3", "", "Trackers");
  appendText(trackerHeading, "span", "", "Availability is the highest fresh report, not a sum.");
  content.append(trackerHeading);

  const trackers = Array.isArray(torrent.trackers) ? torrent.trackers : [];
  if (!trackers.length) {
    appendText(content, "p", "empty-state compact", "No tracker endpoints are configured. DHT availability remains unknown.");
  } else {
    const list = document.createElement("div");
    list.className = "tracker-list";
    for (const tracker of trackers) {
      const row = document.createElement("div");
      row.className = "tracker-row";
      appendText(row, "code", "tracker-endpoint", tracker.endpoint || "Unknown tracker");
      appendText(row, "span", `tracker-state ${tracker.state || "unknown"}`, humanize(tracker.state));
      appendText(row, "span", "", `Seeds: ${trackerSeedersLabel(tracker.seeders)}`);
      appendText(row, "span", "", tracker.updatedAt ? formatAge(tracker.updatedAt) : "No report yet");
      if (tracker.errorCategory) {
        appendText(row, "span", "tracker-error", humanize(tracker.errorCategory));
      }
      list.append(row);
    }
    content.append(list);
  }

  if (torrent.latestTrackerError) {
    const endpoint = torrent.latestTrackerError.endpoint ? ` · ${torrent.latestTrackerError.endpoint}` : "";
    appendText(
      content,
      "p",
      "tracker-warning",
      `Latest tracker issue: ${humanize(torrent.latestTrackerError.category)}${endpoint} · ${formatAge(torrent.latestTrackerError.at)}`
    );
  }
}

async function refreshTorrentDetails() {
  if (detailsRefreshing) {
    detailsRefreshQueued = true;
    return;
  }
  if (
    !selectedTransferId ||
    !elements["torrent-details"].open ||
    document.visibilityState === "hidden"
  ) return;
  const requestedTransferId = selectedTransferId;
  detailsRefreshing = true;
  try {
    const result = await window.watchpair.getTorrentDetails(requestedTransferId);
    if (selectedTransferId !== requestedTransferId || !elements["torrent-details"].open) return;
    renderTorrentDetails(result?.torrent || null);
  } catch (error) {
    if (selectedTransferId !== requestedTransferId || !elements["torrent-details"].open) return;
    elements["torrent-details-content"].replaceChildren();
    appendText(
      elements["torrent-details-content"],
      "p",
      "empty-state error",
      error instanceof Error ? error.message : "Torrent details are unavailable."
    );
  } finally {
    detailsRefreshing = false;
    if (detailsRefreshQueued) {
      detailsRefreshQueued = false;
      void refreshTorrentDetails();
    }
  }
}

function stopDetailsPolling() {
  if (detailsPollTimer) clearInterval(detailsPollTimer);
  detailsPollTimer = null;
}

function startDetailsPolling() {
  stopDetailsPolling();
  if (!elements["torrent-details"].open || document.visibilityState === "hidden") return;
  detailsPollTimer = setInterval(() => void refreshTorrentDetails(), DETAILS_POLL_MS);
}

function openTorrentDetails(job) {
  selectedTransferId = job.id;
  elements["torrent-details-title"].textContent = transferTitle(job);
  elements["torrent-details-subtitle"].textContent = "Live swarm information · updates every 12 seconds while open";
  elements["torrent-details-content"].replaceChildren();
  appendText(elements["torrent-details-content"], "p", "empty-state", "Reading torrent details…");
  if (!elements["torrent-details"].open) elements["torrent-details"].showModal();
  void refreshTorrentDetails();
  startDetailsPolling();
}

function startTransferPolling() {
  if (transferPollTimer) clearInterval(transferPollTimer);
  transferPollTimer = null;
  if (document.visibilityState === "hidden") return;
  transferPollTimer = setInterval(() => void refreshTransfers(), TRANSFER_POLL_MS);
}

function renderLibraryFolders() {
  const container = elements["library-folders"];
  container.replaceChildren();
  appendText(container, "span", "library-folder-note", "The download folder is included automatically.");
  for (const directory of libraryDirectories) {
    const row = document.createElement("span");
    row.className = "library-folder";
    const label = document.createElement("span");
    label.textContent = directory;
    label.title = directory;
    row.append(label);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "library-folder-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove library folder ${directory}`);
    remove.addEventListener("click", () => {
      libraryDirectories = libraryDirectories.filter((candidate) => candidate !== directory);
      renderLibraryFolders();
      setMessage("Save settings to apply the library folder change.");
    });
    row.append(remove);
    container.append(row);
  }
}

function libraryScanLabel(scan) {
  if (scan?.status === "running") return `Scanning · ${scan.scannedFiles || 0} files found`;
  if (scan?.status === "error") return scan.error || "The last library scan failed";
  if (scan?.failedRoots) {
    return `${scan.failedRoots} folder${scan.failedRoots === 1 ? "" : "s"} could not be read`;
  }
  return null;
}

function renderLibrary(result = {}) {
  libraryCollections = Array.isArray(result.collections) ? result.collections : [];
  const total = Number.isFinite(result.total) ? result.total : libraryCollections.length;
  libraryTotal = total;
  libraryOffset = Number.isFinite(result.offset) ? result.offset : libraryOffset;
  const page = Math.floor(libraryOffset / LIBRARY_PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / LIBRARY_PAGE_SIZE));
  elements["library-page"].textContent = `Page ${page} of ${pages}`;
  elements["library-previous"].disabled = libraryOffset <= 0;
  elements["library-next"].disabled = libraryOffset + libraryCollections.length >= total;
    const scanLabel = libraryScanLabel(result.scan);
    elements["library-summary"].textContent = scanLabel || (total
    ? `${total} collection${total === 1 ? "" : "s"} in the local catalog`
      : "No local videos found");
    if (result.scan?.id && result.scan.status === "running") {
      startLibraryScanPolling(result.scan.id);
    }
  elements["library-list"].replaceChildren();
  if (!libraryCollections.length) {
    appendText(
      elements["library-list"],
      "p",
      "empty-state",
      elements["library-search"].value.trim()
        ? "No library items match this search."
        : "Add a library folder or rescan to discover local shows and videos."
    );
    return;
  }

  for (const collection of libraryCollections) {
    const row = document.createElement("article");
    row.className = `library-row${collection.pinned ? " pinned" : ""}`;
    const identity = document.createElement("div");
    identity.className = "library-identity";
    appendText(identity, "strong", "library-name", collection.name || "Library item");
    appendText(
      identity,
      "span",
      "library-state",
      `${collection.itemCount || 0} video${collection.itemCount === 1 ? "" : "s"} · ${formatBytes(collection.size)} · ${collection.managed ? "Managed" : "External"}`
    );
    row.append(identity);

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = `secondary library-pin${collection.pinned ? " selected" : ""}`;
    pin.textContent = collection.managed
      ? collection.pinned ? "Protected" : "Protect download"
      : collection.pinned ? "Cache protected" : "Protect cache";
    pin.setAttribute("aria-pressed", String(Boolean(collection.pinned)));
    pin.title = collection.managed
      ? collection.pinned
        ? "Allow this downloaded show to be cleaned automatically"
        : "Exclude this downloaded show from automatic cleanup"
      : collection.pinned
        ? "Allow the prepared WatchPair cache to be cleaned; external source files remain untouched"
        : "Protect the prepared WatchPair cache; external source files are always left untouched";
    pin.addEventListener("click", () => void setLibraryPinned(collection, !collection.pinned));
    row.append(pin);

    const details = document.createElement("button");
    details.type = "button";
    details.className = "secondary";
    details.textContent = "View";
    details.addEventListener("click", () => void openLibraryDetails(collection));
    row.append(details);
    elements["library-list"].append(row);
  }
}

async function refreshLibrary() {
  const requestGeneration = ++libraryRequestGeneration;
  const requestedQuery = elements["library-search"].value;
  const requestedOffset = libraryOffset;
  if (libraryRefreshing) {
    libraryRefreshQueued = true;
    return;
  }
  if (document.visibilityState === "hidden") return;
  libraryRefreshing = true;
  elements["scan-library"].disabled = true;
  try {
    const result = await window.watchpair.getLibrary({
      query: requestedQuery,
      offset: requestedOffset,
      limit: LIBRARY_PAGE_SIZE,
    });
    if (
      requestGeneration !== libraryRequestGeneration ||
      requestedQuery !== elements["library-search"].value ||
      requestedOffset !== libraryOffset
    ) {
      libraryRefreshQueued = true;
      return;
    }
    renderLibrary(result);
  } catch (error) {
    if (
      requestGeneration !== libraryRequestGeneration ||
      requestedQuery !== elements["library-search"].value ||
      requestedOffset !== libraryOffset
    ) {
      libraryRefreshQueued = true;
      return;
    }
    elements["library-summary"].textContent = error instanceof Error
      ? error.message
      : "The library is unavailable";
  } finally {
    libraryRefreshing = false;
    elements["scan-library"].disabled = busy || libraryScanPolling || Boolean(libraryScanTimer);
    if (libraryRefreshQueued) {
      libraryRefreshQueued = false;
      void refreshLibrary();
    }
  }
}

function queueLibraryRefresh() {
  if (libraryRefreshQueueTimer) clearTimeout(libraryRefreshQueueTimer);
  const refreshWhenIdle = () => {
    libraryRefreshQueueTimer = null;
    if (libraryRefreshing) {
      libraryRefreshQueueTimer = setTimeout(refreshWhenIdle, 100);
      return;
    }
    void refreshLibrary();
  };
  refreshWhenIdle();
}

function stopLibraryScanPolling() {
  if (libraryScanTimer) clearTimeout(libraryScanTimer);
  libraryScanTimer = null;
  activeLibraryScanId = null;
}

async function pollLibraryScan(id) {
  if (activeLibraryScanId !== id || libraryScanPolling) return;
  if (libraryScanTimer) clearTimeout(libraryScanTimer);
  libraryScanTimer = null;
  if (document.visibilityState === "hidden") return;
  libraryScanPolling = true;
  try {
    const scan = await window.watchpair.getLibraryScan(id);
    if (activeLibraryScanId !== id) return;
    elements["library-summary"].textContent = libraryScanLabel(scan) || "Library scan complete";
    if (scan.status === "running") {
      libraryScanTimer = setTimeout(() => void pollLibraryScan(id), LIBRARY_SCAN_POLL_MS);
      return;
    }
    activeLibraryScanId = null;
    await refreshLibrary();
  } catch (error) {
    if (activeLibraryScanId !== id) return;
    activeLibraryScanId = null;
    elements["library-summary"].textContent = error instanceof Error
      ? error.message
      : "The library scan failed";
  } finally {
    libraryScanPolling = false;
    elements["scan-library"].disabled = busy || libraryRefreshing || Boolean(libraryScanTimer);
  }
}

function startLibraryScanPolling(id) {
  if (!id || (activeLibraryScanId === id && (libraryScanTimer || libraryScanPolling))) return;
  stopLibraryScanPolling();
  activeLibraryScanId = id;
  if (libraryScanPolling) {
    libraryScanTimer = setTimeout(() => void pollLibraryScan(id), LIBRARY_SCAN_POLL_MS);
  } else {
    void pollLibraryScan(id);
  }
}

async function scanLibrary() {
  if (libraryRefreshing) return;
  elements["scan-library"].disabled = true;
  try {
    const scan = await window.watchpair.scanLibrary();
    elements["library-summary"].textContent = libraryScanLabel(scan) || "Scanning local videos";
    if (scan?.id && scan.status === "running") startLibraryScanPolling(scan.id);
    else await refreshLibrary();
  } catch (error) {
    elements["library-summary"].textContent = error instanceof Error
      ? error.message
      : "The library scan could not start";
  } finally {
    if (!libraryScanTimer && !libraryScanPolling) elements["scan-library"].disabled = busy;
  }
}

async function setLibraryPinned(collection, pinned) {
  try {
    const result = await window.watchpair.setLibraryPinned(collection.id, pinned);
    const updated = result?.collection || { ...collection, pinned };
    libraryCollections = libraryCollections.map((candidate) =>
      candidate.id === collection.id ? { ...candidate, pinned: Boolean(updated.pinned) } : candidate
    );
    renderLibrary({ collections: libraryCollections, total: libraryTotal, offset: libraryOffset });
    if (selectedLibraryCollectionId === collection.id) renderLibraryDetails(updated);
    const protectedItem = collection.managed ? "Downloaded show" : "Prepared WatchPair cache";
    const externalNote = collection.managed ? "" : " External source files are always left untouched.";
    setMessage(updated.pinned
      ? `${protectedItem} protected from automatic cleanup.${externalNote}`
      : `${protectedItem} can be cleaned automatically.${externalNote}`);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Could not change the pin.", true);
  }
}

function loadHlsRuntime() {
  hlsRuntimePromise ||= import("../../node_modules/hls.js/dist/hls.light.min.mjs")
    .then((module) => module.default);
  return hlsRuntimePromise;
}

function nativeHlsSupported(video) {
  return Boolean(
    video.canPlayType("application/vnd.apple.mpegurl") ||
    video.canPlayType("application/x-mpegURL")
  );
}

async function disposeLibraryPreview(record) {
  if (!record) return;
  if (activeLibraryPreview === record) activeLibraryPreview = null;
  record.hls?.destroy();
  record.video.pause();
  record.video.removeAttribute("src");
  record.video.load();
  record.video.remove();
  try {
    await window.watchpair.stopLibraryPreview(record.sourceId);
  } catch {
    // Main also releases the transient job when the renderer or window closes.
  }
}

function stopActiveLibraryPreview() {
  return disposeLibraryPreview(activeLibraryPreview);
}

async function failLibraryPreview(record, message) {
  if (activeLibraryPreview !== record) return;
  const generation = ++libraryPreviewGeneration;
  await disposeLibraryPreview(record);
  if (generation === libraryPreviewGeneration) setMessage(message, true);
}

async function attachHlsPreview(record) {
  if (nativeHlsSupported(record.video)) {
    record.video.src = record.url;
    return;
  }
  const HlsRuntime = await loadHlsRuntime();
  if (activeLibraryPreview !== record) return;
  if (!HlsRuntime?.isSupported()) {
    throw new Error("This system cannot play the prepared HLS preview.");
  }
  const hls = new HlsRuntime({
    enableWorker: false,
    manifestLoadingTimeOut: 65_000,
    manifestLoadingMaxRetry: 6,
    fragLoadingTimeOut: 65_000,
    fragLoadingMaxRetry: 6,
  });
  record.hls = hls;
  hls.on(HlsRuntime.Events.ERROR, (_event, data) => {
    if (!data.fatal || activeLibraryPreview !== record) return;
    if (data.type === HlsRuntime.ErrorTypes.MEDIA_ERROR && !record.mediaRecoveryAttempted) {
      record.mediaRecoveryAttempted = true;
      hls.recoverMediaError();
      return;
    }
    void failLibraryPreview(
      record,
      data.type === HlsRuntime.ErrorTypes.NETWORK_ERROR
        ? "The companion could not finish preparing that library video."
        : "This system could not decode the prepared library video."
    );
  });
  hls.loadSource(record.url);
  hls.attachMedia(record.video);
}

async function previewLibraryFile(file, parent, { forceHls = false } = {}) {
  const generation = ++libraryPreviewGeneration;
  await stopActiveLibraryPreview();
  if (generation !== libraryPreviewGeneration) return;
  parent.querySelector("video")?.remove();
  if (file.usable === false) {
    setMessage("That video is still downloading or being verified.", true);
    return;
  }

  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.setAttribute("aria-label", `Preview ${file.name}`);
  parent.prepend(video);
  let record = null;
  video.addEventListener("error", () => {
    if (!record || activeLibraryPreview !== record) return;
    if (record.mode === "raw" && !record.fallbackStarted) {
      record.fallbackStarted = true;
      setMessage("Preparing that video for browser playback…");
      void previewLibraryFile(file, parent, { forceHls: true });
      return;
    }
    void failLibraryPreview(record, "The companion could not preview that library video.");
  });

  try {
    const preview = await window.watchpair.startLibraryPreview(file.id, file.name, forceHls);
    if (generation !== libraryPreviewGeneration || !elements["library-details"].open) {
      video.remove();
      if (preview?.sourceId) {
        await window.watchpair.stopLibraryPreview(preview.sourceId).catch(() => {});
      }
      return;
    }
    if (!preview || !["raw", "hls"].includes(preview.mode) ||
        typeof preview.sourceId !== "string" ||
        typeof preview.url !== "string" || !preview.url.startsWith("watchpair-media://")) {
      throw new Error("The companion returned an invalid library preview.");
    }
    record = {
      file,
      video,
      url: preview.url,
      mode: preview.mode,
      sourceId: preview.sourceId,
      hls: null,
      fallbackStarted: forceHls,
      mediaRecoveryAttempted: false,
    };
    activeLibraryPreview = record;
    if (record.mode === "hls") await attachHlsPreview(record);
    else record.video.src = record.url;
  } catch (error) {
    video.remove();
    if (record) await disposeLibraryPreview(record);
    if (generation === libraryPreviewGeneration) {
      setMessage(error instanceof Error ? error.message : "Could not preview that file.", true);
    }
  }
}

function renderLibraryDetails(collection) {
  if (activeLibraryPreview) {
    libraryPreviewGeneration += 1;
    void stopActiveLibraryPreview();
  }
  const content = elements["library-details-content"];
  content.replaceChildren();
  elements["library-details-title"].textContent = collection.name || "Library item";
  elements["library-details-subtitle"].textContent = collection.managed
    ? `WatchPair-managed · ${collection.itemCount || collection.files?.length || 0} videos · ${formatBytes(collection.size)}`
    : `External library · ${collection.itemCount || collection.files?.length || 0} videos · ${formatBytes(collection.size)} · Source files are always left untouched`;

  const actions = document.createElement("div");
  actions.className = "button-row library-detail-actions";
  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "secondary";
  pin.textContent = collection.managed
    ? collection.pinned ? "Unprotect downloaded show" : "Protect downloaded show"
    : collection.pinned ? "Unprotect prepared cache" : "Protect prepared cache";
  pin.setAttribute("aria-pressed", String(Boolean(collection.pinned)));
  pin.title = collection.managed
    ? "Protecting a downloaded show excludes its WatchPair-managed files from automatic cleanup"
    : "Protecting this cache never affects the external source files; WatchPair always leaves them untouched";
  pin.addEventListener("click", () => void setLibraryPinned(collection, !collection.pinned));
  actions.append(pin);
  content.append(actions);

  const files = document.createElement("div");
  files.className = "library-file-list";
  for (const file of Array.isArray(collection.files) ? collection.files : []) {
    const row = document.createElement("div");
    row.className = "library-file-row";
    const identity = document.createElement("div");
    appendText(identity, "strong", "", file.relativePath || file.name || "Video");
    appendText(
      identity,
      "span",
      "library-state",
      file.usable === false
        ? `${formatBytes(file.size)}${file.copyCount > 1 ? ` · ${file.copyCount} local copies` : ""} · Still downloading or verifying`
        : `${formatBytes(file.size)}${file.copyCount > 1 ? ` · ${file.copyCount} local copies` : ""}`
    );
    row.append(identity);
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "secondary";
    preview.textContent = file.usable === false ? "Preview unavailable" : "Preview";
    preview.disabled = file.usable === false;
    preview.title = file.usable === false
      ? "Preview is available after the download is complete and verified"
      : "Preview this library video";
    preview.addEventListener("click", () => void previewLibraryFile(file, content));
    row.append(preview);
    files.append(row);
  }
  content.append(files);
}

async function openLibraryDetails(collection) {
  const requestedCollectionId = collection.id;
  selectedLibraryCollectionId = requestedCollectionId;
  elements["library-details-title"].textContent = collection.name || "Library item";
  elements["library-details-content"].replaceChildren();
  appendText(elements["library-details-content"], "p", "empty-state", "Reading library details…");
  if (!elements["library-details"].open) elements["library-details"].showModal();
  try {
    const result = await window.watchpair.getLibraryCollection(collection.id);
    if (selectedLibraryCollectionId !== requestedCollectionId || !elements["library-details"].open) return;
    renderLibraryDetails(result?.collection || collection);
  } catch (error) {
    if (selectedLibraryCollectionId !== requestedCollectionId || !elements["library-details"].open) return;
    elements["library-details-content"].replaceChildren();
    appendText(
      elements["library-details-content"],
      "p",
      "empty-state error",
      error instanceof Error ? error.message : "Library details are unavailable."
    );
  }
}

function setMessage(message, error = false) {
  elements.message.textContent = message || "";
  elements.message.classList.toggle("error", error);
  elements.message.setAttribute("role", error ? "alert" : "status");
}

function setBusy(value) {
  busy = value;
  elements["save-settings"].disabled = value;
  elements["cleanup-now"].disabled = value;
  elements["check-update"].disabled = value;
  elements["refresh-transfers"].disabled = value || transfersRefreshing;
  elements["scan-library"].disabled = value || libraryRefreshing || libraryScanPolling || Boolean(libraryScanTimer);
  elements["add-library-folder"].disabled = value;
  elements["library-previous"].disabled = value || libraryOffset <= 0;
  elements["library-next"].disabled = value || libraryOffset + libraryCollections.length >= libraryTotal;
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
    libraryDirectories = Array.isArray(settings.libraryDirectories) ? [...settings.libraryDirectories] : [];
    renderLibraryFolders();
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
    libraryDirectories: [...libraryDirectories],
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
    setMessage((typeof success === "function" ? success(next) : success) || "Done");
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
elements["add-library-folder"].addEventListener("click", async () => {
  try {
    const selected = await window.watchpair.chooseLibraryFolder();
    if (!selected || libraryDirectories.includes(selected)) return;
    libraryDirectories.push(selected);
    renderLibraryFolders();
    setMessage("Save settings to scan the new library folder.");
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "Choose a folder inside the drive or share.", true);
  }
});
elements["scan-library"].addEventListener("click", () => void scanLibrary());
elements["library-search"].addEventListener("input", () => {
  if (librarySearchTimer) clearTimeout(librarySearchTimer);
  librarySearchTimer = setTimeout(() => {
    libraryOffset = 0;
    void refreshLibrary();
  }, 220);
});
elements["library-previous"].addEventListener("click", () => {
  libraryOffset = Math.max(0, libraryOffset - LIBRARY_PAGE_SIZE);
  void refreshLibrary();
});
elements["library-next"].addEventListener("click", () => {
  if (libraryOffset + libraryCollections.length >= libraryTotal) return;
  libraryOffset += LIBRARY_PAGE_SIZE;
  void refreshLibrary();
});
elements["open-downloads"].addEventListener("click", () => window.watchpair.openDownloads());
elements["open-logs"].addEventListener("click", () => action(
  () => window.watchpair.openLogs(),
  "Logs opened"
));
elements["save-settings"].addEventListener("click", () => action(
  async () => {
    stopLibraryScanPolling();
    const next = await window.watchpair.saveSettings(formSettings());
    libraryOffset = 0;
    queueLibraryRefresh();
    return next;
  },
  "Settings saved"
));
elements["cleanup-now"].addEventListener("click", () => action(
  () => {
    setMessage("Cleaning…");
    return window.watchpair.cleanup();
  },
  (next) => next?.cleanup?.message || "Cleanup complete"
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
elements["refresh-transfers"].addEventListener("click", () => void refreshTransfers());
elements["close-torrent-details"].addEventListener("click", () => elements["torrent-details"].close());
elements["torrent-details"].addEventListener("close", () => {
  stopDetailsPolling();
  detailsRefreshQueued = false;
  selectedTransferId = null;
});
elements["close-library-details"].addEventListener("click", () => elements["library-details"].close());
elements["library-details"].addEventListener("close", () => {
  selectedLibraryCollectionId = null;
  libraryPreviewGeneration += 1;
  void stopActiveLibraryPreview();
});
window.addEventListener("pagehide", () => {
  libraryPreviewGeneration += 1;
  void stopActiveLibraryPreview();
});
document.addEventListener("visibilitychange", () => {
  startTransferPolling();
  startDetailsPolling();
  if (document.visibilityState === "visible") {
    void refreshTransfers();
    void refreshTorrentDetails();
    void refreshLibrary();
  }
});

window.watchpair.onState((next) => render(next));
window.watchpair.getState()
  .then((next) => render(next, { populateForm: true }))
  .catch((error) => setMessage(error.message, true));
void refreshTransfers();
startTransferPolling();
void refreshLibrary();
