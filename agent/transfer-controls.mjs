const ID = /^[a-zA-Z0-9-]{8,80}$/;
const PRIORITIES = new Set(["low", "normal", "high"]);
export function normalizeTransferControls(value = {}) {
    value = value && typeof value === "object" ? value : {};
    const rate = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1024 ** 4 ? value : 0;
    const ids = (value) => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === "string" && ID.test(id)))].slice(0, 10000) : [];
    const selections = {};
    for (const [id, indexes] of Object.entries(value.selections || {})) {
        if (!ID.test(id) || !Array.isArray(indexes))
            continue;
        selections[id] = [...new Set(indexes.filter(index => Number.isSafeInteger(index) && index >= 0))].slice(0, 10000);
    }
    const priorities = {};
    for (const [id, entries] of Object.entries(value.priorities || {})) {
        if (!ID.test(id) || !entries || typeof entries !== "object")
            continue;
        priorities[id] = Object.fromEntries(Object.entries(entries).filter(([index, priority]) => /^\d{1,8}$/.test(index) && PRIORITIES.has(priority)));
    }
    return {
        downloadLimit: rate(value.downloadLimit), uploadLimit: rate(value.uploadLimit),
        maxActiveDownloads: Number.isInteger(value.maxActiveDownloads) ? Math.max(1, Math.min(16, value.maxActiveDownloads)) : 3,
        queueMode: value.queueMode === "manual" ? "manual" : "playback",
        order: ids(value.order), paused: ids(value.paused), selections, priorities,
    };
}
export function validateBandwidthSettings(value) {
    for (const name of ["downloadLimit", "uploadLimit"]) {
        if (!Number.isSafeInteger(value[name]) || value[name] < 0 || value[name] > 1024 ** 4)
            throw new Error("Bandwidth limits must be whole bytes per second, or zero for unlimited.");
    }
    if (!Number.isInteger(value.maxActiveDownloads) || value.maxActiveDownloads < 1 || value.maxActiveDownloads > 16)
        throw new Error("Choose between 1 and 16 active torrent downloads.");
    if (!["playback", "manual"].includes(value.queueMode))
        throw new Error("Choose a supported queue mode.");
    return { downloadLimit: value.downloadLimit, uploadLimit: value.uploadLimit, maxActiveDownloads: value.maxActiveDownloads, queueMode: value.queueMode };
}
export function orderTransferTargets(targets, controls) {
    const ranks = new Map(controls.order.map((id, index) => [id, index]));
    const priority = { high: 0, normal: 1, low: 2 };
    const compare = (left, right) => (ranks.get(left.jobId) ?? Infinity) - (ranks.get(right.jobId) ?? Infinity) ||
        (priority[controls.priorities[left.jobId]?.[left.fileIndex] || "normal"] - priority[controls.priorities[right.jobId]?.[right.fileIndex] || "normal"]);
    const sorted = controls.queueMode === "manual" ? [...targets].sort(compare)
        : targets.length ? [targets[0], ...targets.slice(1).sort(compare)] : [];
    const activeJobs = new Set();
    return sorted.filter(target => {
        if (controls.paused.includes(target.jobId))
            return false;
        if (!activeJobs.has(target.jobId) && activeJobs.size >= controls.maxActiveDownloads)
            return false;
        activeJobs.add(target.jobId);
        return true;
    });
}
export function transferStage(job) {
    if (job.checking)
        return { key: "checking", label: "Verifying files", reason: "Checking torrent pieces already on disk" };
    if (job.error)
        return { key: "error", label: "Needs attention", reason: job.error };
    if (job.paused)
        return { key: "paused", label: job.manualPaused ? "Paused manually" : "Paused", reason: job.manualPaused ? "Resume in Companion to continue" : "Transfer is paused" };
    if (job.seed)
        return { key: "sharing", label: "Sharing", reason: "Serving verified local media" };
    if (job.status === "metadata" || !job.files?.length)
        return { key: "metadata", label: "Getting metadata", reason: "Finding peers and the torrent file list" };
    const wanted = job.files.filter(file => file.included !== false);
    if (!wanted.length)
        return { key: "waiting", label: "Waiting for selection", reason: "Choose files in Content and apply the selection" };
    if (wanted.some(file => !file.downloadReady && (file.progress || 0) < 100))
        return job.kind === "magnet" && job.downloadRole === "waiting"
            ? { key: "queued", label: "Queued", reason: "Waiting for an active download slot or higher priority files" }
            : { key: "downloading", label: "Downloading", reason: "Downloading selected files" };
    if (wanted.some(file => file.ready))
        return { key: "ready", label: "Ready to play", reason: "At least one selected video is prepared for playback" };
    if (wanted.some(file => file.preparation?.status === "error"))
        return { key: "error", label: "Preparation failed", reason: wanted.find(file => file.preparation?.error)?.preparation.error || "Retry video preparation" };
    return { key: "preparing", label: "Preparing video", reason: "Download finished; preparing browser-compatible playback" };
}

export function groupTransferSnapshots(jobs) {
    const groups = new Map();
    for (const job of jobs) {
        const key = job.sharedTransferId || job.id;
        if (!groups.has(key)) groups.set(key, { key, jobs: [] });
        groups.get(key).jobs.push(job);
    }
    return [...groups.values()].map(group => {
        const included = new Set(group.jobs.flatMap(job => (job.files || []).filter(file => file.included !== false).map(file => file.index)));
        return { ...group, physical: { ...group.jobs[0], files: (group.jobs[0].files || []).map(file => ({ ...file, included: included.has(file.index) })) } };
    });
}
