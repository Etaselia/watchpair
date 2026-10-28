import { transferStage, groupTransferSnapshots, filePlaybackReady } from "../../agent/transfer-controls.mjs";
import { mediaWatchKey } from "../../lib/watch-history.mjs";
const $ = id => document.getElementById(id);
const state = { jobs: [], groups: [], controls: { order: [], priorities: {} }, rooms: [], activity: {}, selected: null,
    roomId: localStorage.getItem("companion-active-room") || "", filter: "all", query: "", tab: "content", page: "transfers",
    sort: "order", descending: false, drafts: new Map(), pending: false, refreshing: false, app: null, telemetry: null };
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined)
    node.textContent = text; if (className)
    node.className = className; return node; };
const button = (text, action, className) => { const node = el("button", text, className); node.type = "button"; node.addEventListener("click", action); return node; };
const bytes = value => { let n = Math.max(0, Number(value) || 0), unit = 0; const units = ["B", "KiB", "MiB", "GiB", "TiB"]; while (n >= 1024 && unit < 4) {
    n /= 1024;
    unit++;
} return `${n.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`; };
const rate = value => `${bytes(value)}/s`;
const age = value => { const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000)); return minutes < 1 ? "Just now" : minutes < 60 ? `${minutes} minutes ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} hours ago` : `${Math.floor(minutes / 1440)} days ago`; };
const room = () => state.rooms.find(room => room.id === state.roomId);
const group = () => state.groups.find(group => group.key === state.selected);
const jobFor = group => {
    const sourceIds = new Set(room()?.sources.map(source => source.id) || []);
    return group?.jobs.find(job => sourceIds.has(job.id)) || group?.jobs[0];
};
const job = () => jobFor(group());
const title = job => job.label || job.files?.[0]?.path?.split("/")[0] || job.files?.[0]?.name || `Transfer ${job.id.slice(0, 8)}`;
const wantedFiles = job => (job.files || []).filter(file => file.included !== false);
const totals = job => { const files = wantedFiles(job), total = files.reduce((sum, file) => sum + file.size, 0), done = files.reduce((sum, file) => sum + Math.min(file.size, file.downloaded || file.size * (file.progress || 0) / 100), 0); return { total, done, progress: total ? Math.min(100, 100 * done / total) : 0 }; };
function message(text, error = false) { $("message").textContent = text; $("message").classList.toggle("error", error); $("message").setAttribute("role", error ? "alert" : "status"); }
function showPage(page, anchor) {
    state.page = page;
    for (const candidate of ["transfers", "library", "settings", "watched"])
        $(candidate === "transfers" ? "transfer-page" : `${candidate}-page`).hidden = candidate !== page;
    $("save-settings").hidden = page !== "settings";
    document.querySelectorAll("[data-page]").forEach(node => node.setAttribute("aria-pressed", String(node.dataset.page === page)));
    if (page === "watched")
        renderWatched();
    if (anchor)
        $(anchor)?.scrollIntoView({ block: "start" });
}
function renderRooms() {
    const select = $("active-room"), previous = state.roomId;
    if (previous && !room())
        state.roomId = "";
    select.replaceChildren(new Option("This device only", ""), ...state.rooms.map(room => new Option(`${room.label} · ${room.host ? "Host" : "Guest"}`, room.id)));
    select.value = state.roomId;
    $("room-permission").textContent = room()?.host ? "Host changes update this room’s shared queue" : room() ? "Guest · downloads affect this device only" : "Local controls · open a room in the browser to connect its queue";
}
function renderJobs() {
    state.groups = groupTransferSnapshots(state.jobs);
    if (!group())
        state.selected = state.groups[0]?.key || null;
    const rank = key => { const index = state.controls.order.indexOf(key); return index < 0 ? state.groups.findIndex(group => group.key === key) + state.controls.order.length : index; };
    const stageCounts = new Map();
    state.groups.forEach(group => { const key = transferStage(group.physical).key; stageCounts.set(key, (stageCounts.get(key) || 0) + 1); });
    document.querySelectorAll("[data-count]").forEach(node => node.textContent = node.dataset.count === "all" ? state.groups.length : stageCounts.get(node.dataset.count) || 0);
    const shown = state.groups.filter(group => { const job = group.physical; return (state.filter === "all" || transferStage(job).key === state.filter) && title(job).toLowerCase().includes(state.query.toLowerCase()); });
    const value = group => { const job = group.physical, sum = totals(job); return state.sort === "name" ? title(job) : state.sort === "size" ? sum.total : state.sort === "progress" ? sum.progress : state.sort === "status" ? transferStage(job).label : state.sort === "seeds" ? job.torrent?.connectedSeeds || 0 : state.sort === "peers" ? job.torrent?.connectedPeers || job.peers || 0 : state.sort === "eta" ? (job.torrent?.downloadSpeed ? (sum.total - sum.done) / job.torrent.downloadSpeed : Infinity) : state.sort === "down" ? job.torrent?.downloadSpeed || 0 : state.sort === "up" ? job.uploadSpeed || 0 : rank(group.key); };
    shown.sort((left, right) => { const a = value(left), b = value(right); return (typeof a === "string" ? a.localeCompare(b, undefined, { numeric: true }) : a - b) * (state.descending ? -1 : 1); });
    const table = el("table", undefined, "transfer-table");
    table.setAttribute("aria-label", "Torrent transfers");
    const columns = [["order", "#", 45], ["name", "Name", 270], ["size", "Wanted", 95], ["progress", "Downloaded", 105], ["status", "Status", 165], ["seeds", "Seeds", 65], ["peers", "Peers", 65], ["down", "Down", 95], ["up", "Up", 90], ["eta", "ETA", 75]];
    const head = el("thead"), heading = el("tr");
    for (const [key, label, width] of columns) {
        const cell = el("th");
        let saved;
        try {
            saved = JSON.parse(localStorage.getItem("companion-columns") || "{}")[key];
        }
        catch { /* reset malformed preferences */ }
        cell.style.width = `${saved || width}px`;
        cell.scope = "col";
        cell.append(button(label + (state.sort === key ? (state.descending ? " ▾" : " ▴") : ""), () => { if (["seeds", "peers", "eta"].includes(key)) {
            state.sort = key;
            state.descending = !state.descending;
        }
        else {
            state.descending = state.sort === key ? !state.descending : false;
            state.sort = key;
        } renderJobs(); }));
        const grip = el("span", undefined, "column-grip");
        grip.setAttribute("aria-hidden", "true");
        grip.addEventListener("pointerdown", event => { event.preventDefault(); const start = event.clientX, initial = cell.getBoundingClientRect().width; grip.setPointerCapture(event.pointerId); const move = event => cell.style.width = `${Math.max(40, initial + event.clientX - start)}px`; const done = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", done); let saved = {}; try {
            saved = JSON.parse(localStorage.getItem("companion-columns") || "{}");
        }
        catch { /* reset */ } saved[key] = Math.round(cell.getBoundingClientRect().width); localStorage.setItem("companion-columns", JSON.stringify(saved)); }; grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", done); });
        cell.append(grip);
        heading.append(cell);
    }
    head.append(heading);
    table.append(head);
    const body = el("tbody");
    for (const group of shown) {
        const job = group.physical, sum = totals(job), stage = transferStage(job), row = el("tr");
        row.classList.toggle("selected", group.key === state.selected);
        row.setAttribute("aria-selected", String(group.key === state.selected));
        const name = button(title(job), () => { state.selected = group.key; state.telemetry = null; renderJobs(); renderDetail(); });
        name.title = title(job);
        const progress = el("div", undefined, "desk-progress");
        progress.setAttribute("role", "progressbar");
        progress.setAttribute("aria-label", `${title(job)} selected files downloaded`);
        progress.setAttribute("aria-valuemin", "0");
        progress.setAttribute("aria-valuemax", "100");
        progress.setAttribute("aria-valuenow", String(Math.round(sum.progress)));
        const fill = el("i");
        fill.style.width = `${sum.progress}%`;
        progress.append(fill, el("span", `${Math.round(sum.progress)}%`));
        const speed = job.torrent?.downloadSpeed || 0, seconds = speed > 0 ? (sum.total - sum.done) / speed : 0;
        for (const content of [String(rank(group.key) + 1), name, bytes(sum.total), progress, stage.label, String(job.torrent?.connectedSeeds ?? 0), String(job.torrent?.connectedPeers ?? job.peers ?? 0), rate(speed), rate(job.uploadSpeed), sum.total && sum.progress === 100 ? "Done" : seconds ? seconds < 60 ? "<1m" : `${Math.ceil(seconds / 60)}m` : "—"]) {
            const cell = el("td");
            if (typeof content === "string")
                cell.textContent = content;
            else
                cell.append(content);
            row.append(cell);
        }
        row.children[4].title = stage.reason;
        if (stage.key === "error")
            row.children[4].className = "desk-error";
        body.append(row);
    }
    if (!shown.length) {
        const row = el("tr"), cell = el("td", state.groups.length ? "No matching transfers" : "Add a torrent, or download media from a connected room.", "desk-note");
        cell.colSpan = 10;
        row.append(cell);
        body.append(row);
    }
    table.append(body);
    const scroll = $("transfer-list"), left = scroll.scrollLeft, top = scroll.scrollTop;
    scroll.replaceChildren(table);
    scroll.scrollLeft = left;
    scroll.scrollTop = top;
    $("transfers-summary").textContent = `${state.groups.length} transfers · ↓ ${rate(state.groups.reduce((sum, group) => sum + (jobFor(group).torrent?.downloadSpeed || 0), 0))} · ↑ ${rate(state.groups.reduce((sum, group) => sum + (jobFor(group).uploadSpeed || 0), 0))}`;
    document.querySelectorAll("[data-command]").forEach(node => node.disabled = state.pending || (node.dataset.command !== "add" && !job()));
}
function draftFor(job) {
    let draft = state.drafts.get(job.id);
    if (!draft || !draft.dirty) {
        draft = { wanted: new Set(wantedFiles(job).map(file => file.index)), priorities: Object.fromEntries((job.files || []).map(file => [file.index, file.downloadPriority || "normal"])), dirty: false, expanded: draft?.expanded || new Set(), query: draft?.query || "", offset: draft?.offset || 0 };
        state.drafts.set(job.id, draft);
    }
    return draft;
}
function metricList(entries) { const list = el("dl"); for (const [key, value] of entries) {
    list.append(el("dt", key), el("dd", String(value ?? "—")));
} return list; }
function watchRecord(file, job) {
    const connectedRoom = room();
    if (!connectedRoom) return undefined;
    const source = connectedRoom.sources.find(source => source.id === job.id) || { id: job.id, kind: job.kind, infoHash: job.infoHash };
    return connectedRoom.watchRecords?.[mediaWatchKey(source, { fileIndex: file.index })];
}
function table(headers, rows) { const result = el("table", undefined, "file-table"), head = el("thead"), tr = el("tr"); headers.forEach(text => tr.append(el("th", text))); head.append(tr); result.append(head); const body = el("tbody"); for (const values of rows) {
    const row = el("tr");
    for (const value of values)
        row.append(el("td", value));
    body.append(row);
} result.append(body); return result; }
function redrawContent(job, draft, container) {
    const focused = document.activeElement?.id, position = document.activeElement?.selectionStart, scroll = container.querySelector(".files-scroll")?.scrollTop || 0;
    container.replaceChildren();
    const actions = el("div", undefined, "desk-actions");
    for (const [label, predicate] of [["Select all", () => true], ["Select none", () => false], ["Skip watched", file => !watchRecord(file, job)?.watchedAt]])
        actions.append(button(label, () => { draft.wanted = new Set(job.files.filter(predicate).map(file => file.index)); draft.dirty = true; redrawContent(job, draft, container); }));
    const search = el("input");
    search.type = "search";
    search.id = "content-filter";
    search.className = "file-filter";
    search.placeholder = "Find files or folders…";
    search.setAttribute("aria-label", "Filter torrent content");
    search.value = draft.query;
    search.addEventListener("input", () => { draft.query = search.value; draft.offset = 0; redrawContent(job, draft, container); });
    actions.append(search, el("span", `${draft.wanted.size} files · ${bytes(job.files.filter(file => draft.wanted.has(file.index)).reduce((sum, file) => sum + file.size, 0))} selected${draft.dirty ? " · Unsaved changes" : ""}`, "desk-muted push"));
    container.append(actions);
    const tree = { path: "", folders: new Map(), files: [], all: [] };
    for (const file of job.files) {
        let node = tree;
        node.all.push(file);
        const parts = String(file.path || file.name).replaceAll("\\", "/").split("/");
        parts.pop();
        for (const part of parts) {
            if (!node.folders.has(part))
                node.folders.set(part, { name: part, path: node.path + "/" + part, folders: new Map(), files: [], all: [] });
            node = node.folders.get(part);
            node.all.push(file);
        }
        node.files.push(file);
    }
    const flat = [], query = draft.query.toLowerCase();
    function walk(node, depth) { for (const folder of [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
        if (query && !folder.all.some(file => String(file.path || file.name).toLowerCase().includes(query)))
            continue;
        flat.push({ folder, depth });
        if (query || draft.expanded.has(folder.path))
            walk(folder, depth + 1);
    } for (const file of node.files)
        if (!query || String(file.path || file.name).toLowerCase().includes(query))
            flat.push({ file, depth }); }
    walk(tree, 0);
    draft.offset = Math.min(draft.offset, Math.max(0, Math.floor((flat.length - 1) / 200) * 200));
    const scrollBox = el("div", undefined, "files-scroll"), fileTable = table(["Content", "Size", "Downloaded", "Priority", "Room / playback"], []), tbody = fileTable.querySelector("tbody");
    for (const entry of flat.slice(draft.offset, draft.offset + 200)) {
        const row = el("tr"), identity = el("td"), wrap = el("div"), folder = entry.folder, file = entry.file, files = folder ? folder.all : [file];
        wrap.style.paddingLeft = `${Math.min(entry.depth, 20) * 16}px`;
        const wanted = files.filter(file => draft.wanted.has(file.index)).length, check = el("input");
        check.type = "checkbox";
        check.checked = wanted === files.length;
        check.indeterminate = wanted > 0 && wanted < files.length;
        check.setAttribute("aria-label", `Download ${folder ? folder.name : file.name}`);
        check.addEventListener("change", () => { for (const file of files) {
            if (check.checked)
                draft.wanted.add(file.index);
            else
                draft.wanted.delete(file.index);
        } draft.dirty = true; redrawContent(job, draft, container); });
        if (folder) {
            row.className = "folder-row";
            const expand = button(draft.expanded.has(folder.path) ? "▾" : "▸", () => { if (draft.expanded.has(folder.path))
                draft.expanded.delete(folder.path);
            else
                draft.expanded.add(folder.path); redrawContent(job, draft, container); }, "folder-expand");
            expand.setAttribute("aria-label", `${draft.expanded.has(folder.path) ? "Collapse" : "Expand"} ${folder.name}`);
            expand.setAttribute("aria-expanded", String(draft.expanded.has(folder.path)));
            wrap.append(expand);
        }
        const label = el("label");
        label.append(check, el("span", folder ? `${folder.name} · ${folder.all.length} files` : file.name));
        wrap.append(label);
        identity.append(wrap);
        row.append(identity, el("td", bytes(files.reduce((sum, file) => sum + file.size, 0))), el("td", `${Math.round(totals({ files }).progress)}%`));
        const priority = el("select");
        priority.setAttribute("aria-label", `${folder ? folder.name : file.name} priority`);
        for (const [key, text] of [["skip", "Do not download"], ["low", "Low"], ["normal", "Normal"], ["high", "High"]])
            priority.append(new Option(text, key));
        priority.value = wanted ? (folder ? "normal" : draft.priorities[file.index] || "normal") : "skip";
        priority.addEventListener("change", () => { for (const file of files) {
            if (priority.value === "skip")
                draft.wanted.delete(file.index);
            else {
                draft.wanted.add(file.index);
                draft.priorities[file.index] = priority.value;
            }
        } draft.dirty = true; redrawContent(job, draft, container); });
        const priorityCell = el("td");
        priorityCell.append(priority);
        row.append(priorityCell);
        const record = file ? watchRecord(file, job) : null;
        const selected = room()?.selectedMedia?.sourceId === job.id && room()?.selectedMedia?.fileIndex === file?.index;
        const status = record?.watchedAt ? `Watched · ${age(record.watchedAt)}` : selected ? "Selected in room" : file && filePlaybackReady(file, job) ? "Ready to play" : ["preparing", "queued"].includes(file?.preparation?.status) ? "Preparing video" : folder ? `${wanted} of ${files.length} selected` : file?.downloadReady ? "Preparing video" : file?.status || "Waiting";
        const statusCell = el("td", status);
        if (record?.watchedAt)
            statusCell.title = new Date(record.watchedAt).toLocaleString();
        row.append(statusCell);
        tbody.append(row);
    }
    scrollBox.append(fileTable);
    container.append(scrollBox);
    if (flat.length > 200) {
        const pages = el("div", undefined, "desk-actions");
        const previous = button("Previous files", () => { draft.offset = Math.max(0, draft.offset - 200); redrawContent(job, draft, container); }), next = button("Next files", () => { draft.offset += 200; redrawContent(job, draft, container); });
        previous.disabled = draft.offset === 0;
        next.disabled = draft.offset + 200 >= flat.length;
        pages.append(previous, el("span", `${draft.offset + 1}–${Math.min(flat.length, draft.offset + 200)} of ${flat.length}`), next);
        container.append(pages);
    }
    const apply = el("div", undefined, "desk-actions"), sync = el("input");
    sync.type = "checkbox";
    sync.checked = Boolean(room()?.host);
    sync.disabled = !room()?.host;
    sync.id = "sync-room-selection";
    const syncRoomId = room()?.id;
    const syncLabel = el("label");
    syncLabel.append(sync, el("span", room()?.host ? `Update ${room().label} shared queue` : room() ? "Guest · this device only" : "This device only"));
    apply.append(syncLabel, button("Apply selection", async () => {
        if (sync.checked && (!room()?.host || room()?.id !== syncRoomId)) {
            message("The room connection changed. Reconnect and apply the shared selection again.", true);
            return;
        }
        const priorities = Object.fromEntries([...draft.wanted].map(index => [index, draft.priorities[index] || "normal"]));
        await command({ command: "selection", id: job.id, fileIndexes: [...draft.wanted], priorities, roomId: sync.checked ? syncRoomId : undefined }, () => { draft.dirty = false; });
    }, "primary"));
    if (job.manualSelection)
        apply.append(button("Follow room choices", () => command({ command: "follow-room", id: job.id }, () => { draft.dirty = false; })));
    container.append(apply, el("p", room()?.host ? "Applying a selection that excludes the playing episode immediately switches the room to its next selected, unwatched episode. Downloaded files are kept." : "Changing download choices keeps existing files and watch history.", "desk-note"));
    if (focused === "content-filter") {
        const input = $(focused);
        input?.focus();
        if (position !== null)
            try {
                input.setSelectionRange(position, position);
            }
            catch { /* search inputs may omit selection ranges */ }
    }
    scrollBox.scrollTop = scroll;
}
function renderDetail(force = false) {
    const current = job(), container = $("transfer-detail");
    container.classList.toggle("content-pane", state.tab === "content" && current?.kind === "magnet" && !current.seed && Boolean(current.files?.length));
    if (!force && container.contains(document.activeElement) && ["INPUT", "SELECT"].includes(document.activeElement.tagName))
        return;
    if (!force && state.tab === "speed" && container.querySelector("form")?.dataset.dirty === "true")
        return;
    const scroll = container.scrollTop;
    container.replaceChildren();
    document.querySelectorAll("[data-detail-tab]").forEach(node => node.setAttribute("aria-selected", String(node.dataset.detailTab === state.tab)));
    container.setAttribute("aria-labelledby", `tab-${state.tab}`);
    if (state.tab === "speed") {
        $("detail-title").textContent = "Torrent bandwidth and queue";
        renderSpeed(container);
        return;
    }
    if (!current) {
        $("detail-title").textContent = "Select a transfer";
        container.append(el("p", "Torrent files, status, and room controls appear here.", "desk-note"));
        return;
    }
    const stage = transferStage(current), sum = totals(current);
    $("detail-title").textContent = `${title(current)} · ${stage.label}`;
    if (state.tab === "content") {
        if (!current.files?.length)
            container.append(el("p", stage.reason, "desk-note"));
        else if (current.seed || current.kind !== "magnet")
            container.append(table(["File", "Size", "State"], current.files.map(file => [file.name, bytes(file.size), filePlaybackReady(file, current) ? "Ready to play" : file.downloadReady ? "Preparing video" : file.status])));
        else
            {
                const videoJob = { ...current, files: current.files.filter(file => /\.(mp4|m4v|webm|ogv|mov|mkv|avi|ts)$/i.test(file.path || file.name)) };
                redrawContent(videoJob, draftFor(videoJob), container);
            }
    }
    else if (state.tab === "general") {
        container.append(el("p", stage.reason, stage.key === "error" ? "desk-error" : "desk-note"));
        const metrics = el("div", undefined, "desk-metrics");
        metrics.append(metricList([["Wanted", bytes(sum.total)], ["Downloaded", bytes(sum.done)], ["Total torrent", bytes(current.files.reduce((sum, file) => sum + file.size, 0))], ["Added", new Date(current.createdAt).toLocaleString()]]), metricList([["Download", rate(current.torrent?.downloadSpeed)], ["Upload", rate(current.uploadSpeed)], ["Connected seeds", current.torrent?.connectedSeeds], ["Connected peers", current.torrent?.connectedPeers ?? current.peers]]), metricList([["Transfer ID", group().key], ["Source links", group().jobs.length], ["Verification failures", current.verification?.peerFailures ?? 0], ["Manual pause", current.manualPaused ? "Until resumed in Companion" : "No"]]));
        container.append(metrics);
    }
    else if (state.tab === "speed")
        renderSpeed(container);
    else if (state.tab === "storage") {
        const storage = state.app?.agent.storage?.usage;
        container.append(metricList([["Location", state.directory], ["On-disk usage", bytes(storage?.bytes)], ["Free space", bytes(storage?.availableBytes)], ["Selected data", bytes(sum.total)], ["References to this transfer", group().jobs.length], ["Cleanup protection", current.pinned ? "Pinned" : group().jobs.length > 1 ? "Shared by multiple sources" : "Protected while in use"]]));
        const actions = el("div", undefined, "desk-actions");
        actions.append(button("Open downloads", () => window.watchpair.openDownloads()), button(current.pinned ? "Unpin transfer" : "Keep this transfer", () => command({ command: "pin", id: current.id, pinned: !current.pinned })), button("Cleanup settings", () => showPage("settings", "storage-title")), button("Remove…", () => removeDialog(current)));
        container.append(actions, el("p", "Removing a source keeps files by default. Shared downloads cannot be deleted while another source still references them. Cleanup settings include retention, cache, storage limit, and free-space reserve.", "desk-note"));
    }
    else if (state.tab === "activity") {
        container.append(el("p", stage.reason, stage.key === "error" ? "desk-error" : "desk-note"));
        const actions = el("div", undefined, "desk-actions");
        actions.append(button("Retry transfer", () => command({ command: "retry", id: current.id })), button("Open logs", () => window.watchpair.openLogs()));
        container.append(actions);
        const list = el("ol", undefined, "activity-list");
        for (const event of state.activity[group().key] || []) {
            const row = el("li"), time = el("time", new Date(event.at).toLocaleTimeString());
            time.dateTime = new Date(event.at).toISOString();
            row.append(time, el("span", event.message));
            list.append(row);
        }
        if (!list.children.length)
            container.append(el("p", "No manual actions recorded in this Companion session. Persistent engine logs are available through Open logs.", "desk-note"));
        container.append(list);
    }
    else if (state.tab === "rooms") {
        const links = state.rooms.filter(room => room.sources.some(source => group().jobs.some(job => job.id === source.id)));
        container.append(table(["Room", "Role", "Selected video", "File choices"], links.map(room => [room.label, room.host ? "Host" : "Guest", room.selectedMedia?.name || "None", room.host ? "Shared queue + this device" : "This device only"])));
        if (!links.length)
            container.append(el("p", "This transfer has no linked, connected room. Open a room in the browser, choose it above, then apply a file selection to add this torrent.", "desk-note"));
    }
    else
        renderSwarm(container, current);
    container.scrollTop = scroll;
}
function renderSpeed(container) {
    const form = el("form"), grid = el("div", undefined, "desk-grid");
    form.dataset.dirty = "false";
    for (const [key, label, divisor] of [["downloadLimit", "Torrent download limit (KiB/s)", 1024], ["uploadLimit", "Torrent upload limit (KiB/s)", 1024], ["maxActiveDownloads", "Maximum active torrent downloads", 1]]) {
        const wrap = el("label", label), input = el("input");
        input.name = key;
        input.type = "number";
        input.min = key === "maxActiveDownloads" ? "1" : "0";
        input.max = key === "maxActiveDownloads" ? "16" : "1073741824";
        input.step = "1";
        input.value = String((state.controls[key] || 0) / divisor);
        input.required = true;
        wrap.append(input);
        grid.append(wrap);
    }
    const wrap = el("label", "Queue mode"), select = el("select");
    select.name = "queueMode";
    select.append(new Option("Playback first, then queue order", "playback"), new Option("Manual queue and file priorities", "manual"));
    select.value = state.controls.queueMode || "playback";
    wrap.append(select);
    grid.append(wrap);
    form.append(grid, el("p", "0 = unlimited. Limits apply across all torrent downloads and shares. Manual pauses remain in effect in both queue modes.", "desk-note"));
    const submit = el("button", "Apply limits", "primary");
    submit.type = "submit";
    form.append(submit);
    form.addEventListener("input", () => { form.dataset.dirty = "true"; });
    form.addEventListener("submit", event => { event.preventDefault(); const data = new FormData(form); void command({ command: "limits", downloadLimit: Number(data.get("downloadLimit")) * 1024, uploadLimit: Number(data.get("uploadLimit")) * 1024, maxActiveDownloads: Number(data.get("maxActiveDownloads")), queueMode: data.get("queueMode") }, () => { form.dataset.dirty = "false"; }); });
    container.append(form);
}
async function renderSwarm(container, current) {
    const key = current.id, tab = state.tab;
    container.append(el("p", "Reading live swarm details…", "desk-note"));
    try {
        const result = await window.watchpair.getTorrentDetails(key);
        if (job()?.id !== key || state.tab !== tab)
            return;
        container.replaceChildren();
        if (tab === "trackers") {
            container.append(button("Reannounce", () => command({ command: "reannounce", id: key })), el("p", "Tracker seed counts may differ from connected seeds. Addresses omit tracker credentials.", "desk-note"));
            container.append(table(["Tracker", "State", "Seeds", "Peers", "Last response", "Error"], (result.torrent?.trackers || []).map(tracker => [tracker.endpoint, tracker.state, String(tracker.seeders ?? "Unknown"), String(tracker.leechers ?? "Unknown"), tracker.updatedAt ? age(tracker.updatedAt) : "Never", tracker.errorCategory || "—"])));
        }
        else {
            container.append(table(["Peer", "Client", "Down", "Up"], (result.peers || []).map(peer => [peer.address, peer.client, rate(peer.downloadSpeed), rate(peer.uploadSpeed)])));
            if (!result.peers?.length)
                container.append(el("p", "No peers connected to this transfer.", "desk-note"));
        }
    }
    catch (error) {
        if (job()?.id === key && state.tab === tab)
            container.replaceChildren(el("p", error.message, "desk-note"));
    }
}
function dialog(title, content, confirmText, confirm) { $("transfer-dialog-title").textContent = title; $("transfer-dialog-body").replaceChildren(content); $("confirm-transfer-dialog").textContent = confirmText; $("confirm-transfer-dialog").onclick = confirm; $("transfer-dialog").showModal(); }
function removeDialog(current) { const content = el("div"); content.append(el("p", title(current))); const label = el("label"), check = el("input"); check.type = "checkbox"; check.disabled = group().jobs.length > 1; label.append(check, el("span", "Also delete downloaded files")); content.append(label, el("p", group().jobs.length > 1 ? "These files are shared. Only the selected source link will be removed; its other references and files remain." : "Files are kept unless you explicitly choose deletion. Room queue entries are unchanged.", "desk-note")); dialog("Remove transfer", content, "Remove", async () => { if (await command({ command: "remove", id: current.id, deleteFiles: check.checked }))
    $("transfer-dialog").close(); }); }
function addDialog() { const content = el("div"), label = el("label", "Magnet, .torrent URL, or Nyaa link"), input = el("input"); input.type = "text"; input.id = "add-torrent-source"; input.maxLength = 8000; input.style.width = "100%"; label.append(input); content.append(label, el("p", "Only metadata downloads initially. Choose seasons and files in Content before downloading video. Existing owned transfers are reused.", "desk-note")); dialog("Add torrent", content, "Load file list", async () => { const result = await command({ command: "add", value: input.value.trim() }); if (result?.job) {
    state.selected = result.job.sharedTransferId || result.job.id;
    state.tab = "content";
    $("transfer-dialog").close();
    showPage("transfers");
    await refresh(true);
} }); input.focus(); }
async function reorder(direction) { const current = group(); if (!current)
    return; const order = [...state.groups].sort((a, b) => { const rank = id => { const i = state.controls.order.indexOf(id); return i < 0 ? state.controls.order.length + state.groups.findIndex(g => g.key === id) : i; }; return rank(a.key) - rank(b.key); }).map(group => group.key); const index = order.indexOf(current.key), next = Math.max(0, Math.min(order.length - 1, index + direction)); [order[index], order[next]] = [order[next], order[index]]; const ids = order.map(key => jobFor(state.groups.find(group => group.key === key)).id); await command({ command: "order", ids, roomId: room()?.host ? room().id : undefined }); }
async function command(value, onSuccess) { if (state.pending)
    return null; state.pending = true; $("transfer-detail").inert = true; $("transfer-detail").setAttribute("aria-busy", "true"); renderJobs(); message("Applying…"); try {
    const result = await window.watchpair.transferCommand(value);
    onSuccess?.();
    await refresh(true);
    message(value.command === "selection" && value.roomId ? "File choices saved; active room queue synchronized." : value.command === "pause" ? "Paused manually. Browser refreshes will not resume this transfer." : "Saved");
    return result;
}
catch (error) {
    message(error.message || "The command failed.", true);
    return null;
}
finally {
    state.pending = false;
    $("transfer-detail").inert = false;
    $("transfer-detail").setAttribute("aria-busy", "false");
    renderJobs();
} }
async function refresh(force = false) {
    if (state.refreshing) {
        await state.refreshing;
        if (!force) return;
    }
    const operation = (async () => { try {
    const [data, jobs] = await Promise.all([window.watchpair.getTransferControls(), window.watchpair.getTransfers()]);
    Object.assign(state, data);
    state.jobs = jobs.jobs || [];
    renderRooms();
    renderJobs();
    renderDetail();
    if (state.page === "watched")
        renderWatched();
}
catch (error) {
    message(error.message, true);
}
} )();
    state.refreshing = operation;
    await operation;
    if (state.refreshing === operation) state.refreshing = false;
}
function renderWatched() { const container = $("watched-list"); container.replaceChildren(); const records = Object.values(room()?.watchRecords || {}).filter(record => record.watchedAt).sort((a, b) => b.watchedAt - a.watchedAt); if (!records.length)
    container.append(el("p", room() ? "Nothing watched in this room yet." : "Choose a connected room above to see its watch history.", "desk-note")); for (const record of records) {
    const row = el("div", undefined, "watch-row"), text = el("div");
    text.append(el("strong", record.media.name), el("p", `Watched ${age(record.watchedAt)}`, "desk-muted"));
    text.title = new Date(record.watchedAt).toLocaleString();
    row.append(text);
    if (room().host) {
        row.append(button("Watch again", () => command({ command: "watch", roomId: room().id, state: "again", key: record.key })));
    }
    container.append(row);
} }
document.querySelectorAll("[data-page]").forEach(node => node.addEventListener("click", () => showPage(node.dataset.page, node.dataset.anchor)));
document.querySelectorAll("[data-filter]").forEach(node => node.addEventListener("click", () => { state.filter = node.dataset.filter; showPage("transfers"); document.querySelectorAll("[data-filter]").forEach(button => button.setAttribute("aria-pressed", String(button === node))); renderJobs(); }));
document.querySelectorAll("[data-detail-tab]").forEach(node => node.addEventListener("click", () => { state.tab = node.dataset.detailTab; renderDetail(true); }));
document.querySelectorAll("[data-command]").forEach(node => node.addEventListener("click", () => { const commandName = node.dataset.command; if (commandName === "add")
    return addDialog(); if (!job())
    return; if (commandName === "remove")
    return removeDialog(job()); if (commandName === "up" || commandName === "down")
    return void reorder(commandName === "up" ? -1 : 1); void command({ command: commandName, id: job().id }); }));
$("transfer-search").addEventListener("input", event => { state.query = event.target.value; renderJobs(); });
$("active-room").addEventListener("change", event => { if ([...state.drafts.values()].some(draft => draft.dirty) && !confirm("Discard unapplied file choices and switch rooms?")) {
    event.target.value = state.roomId;
    return;
} state.drafts.clear(); state.roomId = event.target.value; localStorage.setItem("companion-active-room", state.roomId); renderRooms(); renderJobs(); renderDetail(true); renderWatched(); });
$("detail-height").value = localStorage.getItem("companion-detail-height") || "320";
function resizeDetail() { const height = Math.max(190, Math.min(600, Number($("detail-height").value) || 320)); $("transfer-page").style.setProperty("--detail-height", `${height}px`); localStorage.setItem("companion-detail-height", String(height)); }
$("detail-height").addEventListener("input", resizeDetail);
resizeDetail();
$("cancel-transfer-dialog").addEventListener("click", () => $("transfer-dialog").close());
window.companionDesk = { refresh, render(jobs) { state.jobs = jobs; renderJobs(); renderDetail(); }, setState(app) { const becameReady = state.app?.agent.status !== "ready" && app.agent.status === "ready"; state.app = app; if (becameReady)
        void refresh(); } };
showPage("transfers");
renderJobs();
renderDetail();
window.watchpair.getState().then(app => { state.app = app; void refresh(); }).catch(() => { });
void refresh();
