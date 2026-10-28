"use client";

import { useEffect, useRef, useState } from "react";
import { Folder, X } from "lucide-react";
import { mediaFolderTree, type MediaFolder } from "../lib/media-queue.mjs";
import { isMediaWatched } from "../lib/watch-history.mjs";
import { formatBytes } from "../lib/media";
import type { SharedMediaItem, SharedSource, WatchRecord } from "../lib/session-types";

function FolderCheckbox({ selected, total, label, onChange }: {
  selected: number; total: number; label: string; onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = selected > 0 && selected < total; }, [selected, total]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={total > 0 && selected === total}
    onChange={(event) => onChange(event.currentTarget.checked)} />;
}

function descendants(folder: MediaFolder): SharedMediaItem[] {
  return [...folder.items, ...folder.children.flatMap(descendants)];
}

interface FilePickerProps {
  source: SharedSource; records: Record<string, WatchRecord>;
  onApply: (ids: string[]) => Promise<void>;
  onWatch: (ids: string[], watched: boolean) => Promise<void>;
  onClose: () => void;
}

export default function TorrentFilePicker({ status, onLoad, onRetry, ...props }: FilePickerProps & {
  status: string; onLoad?: () => void; onRetry?: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog className="torrent-picker" ref={dialog} aria-labelledby="torrent-picker-title" onCancel={props.onClose}>
    <div className="library-header">
      <div><h2 id="torrent-picker-title">Choose files to download</h2><p>{props.source.label}</p></div>
      <button className="icon-button" type="button" aria-label="Close file selection" onClick={props.onClose}><X /></button>
    </div>
    <p>These choices apply to the room. Each device keeps its own download policy.</p>
    {props.source.mediaItems?.length ? <FilePickerContents {...props} /> : <>
      <p role="status">{status}</p>
      {props.source.selectionConfirmed === false && <p>No videos will download until you apply a selection.</p>}
      <div className="folder-selection-actions">
        <button className="secondary-button" type="button" onClick={props.onClose}>Close</button>
        {onLoad && <button className="primary-button" type="button" onClick={onLoad}>Load file list</button>}
        {onRetry && <button className="primary-button" type="button" onClick={() => void onRetry()}>Retry file list</button>}
      </div>
    </>}
  </dialog>;
}

function FilePickerContents({ source, records, onApply, onWatch, onClose }: FilePickerProps) {
  const items = source.mediaItems || [];
  const [chosen, setChosen] = useState(() => new Set(items.filter((item) =>
    item.included && !isMediaWatched(records, source, item)).map((item) => item.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = (files: SharedMediaItem[], checked: boolean) => setChosen((current) => {
    const next = new Set(current);
    files.forEach((item) => { if (checked) next.add(item.id); else next.delete(item.id); });
    return next;
  });
  const run = async (work: () => Promise<void>, close = false) => {
    setBusy(true);
    setError("");
    try { await work(); if (close) onClose(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not update files."); }
    finally { setBusy(false); }
  };
  const renderFolder = (folder: MediaFolder) => {
    const files = descendants(folder);
    const selected = files.filter((item) => chosen.has(item.id)).length;
    const watched = files.filter((item) => isMediaWatched(records, source, item)).length;
    return <details className="torrent-folder" key={folder.path} open={folder.path === ""}>
      <summary>
        <span onClick={(event) => event.stopPropagation()}>
          <FolderCheckbox selected={selected} total={files.length} label={`Download ${folder.name}`}
            onChange={(checked) => toggle(files, checked)} />
        </span>
        <Folder aria-hidden="true" /><strong>{folder.name}</strong>
        <small>{selected}/{files.length} selected · {formatBytes(files.reduce((sum, item) => sum + item.size, 0))}</small>
      </summary>
      <div className="folder-watch-actions">
        <button type="button" disabled={busy || watched === files.length}
          onClick={() => void run(() => onWatch(files.map((item) => item.id), true))}>Mark folder watched</button>
        <button type="button" disabled={busy || !watched}
          onClick={() => void run(() => onWatch(files.map((item) => item.id), false))}>Mark folder unwatched</button>
      </div>
      {folder.children.map(renderFolder)}
      {folder.items.map((item) => <label className="torrent-picker-file" key={item.id}>
        <input type="checkbox" checked={chosen.has(item.id)} disabled={busy}
          onChange={(event) => toggle([item], event.currentTarget.checked)} />
        <span title={item.path}>{item.name}<small>{formatBytes(item.size)}{isMediaWatched(records, source, item) ? " · Watched" : ""}</small></span>
      </label>)}
    </details>;
  };
  const selected = items.filter((item) => chosen.has(item.id));
  return <>
    {items.some((item) => isMediaWatched(records, source, item)) &&
      <p>Watched episodes stay in Watched. Mark them unwatched to queue them again.</p>}
    <div className="folder-selection-actions">
      <button type="button" disabled={busy} onClick={() => toggle(items, true)}>Select all</button>
      <button type="button" disabled={busy} onClick={() => toggle(items, false)}>Select none</button>
      <strong>{selected.length} videos · {formatBytes(selected.reduce((sum, item) => sum + item.size, 0))}</strong>
    </div>
    <fieldset disabled={busy} className="torrent-tree">{renderFolder(mediaFolderTree(items))}</fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="folder-selection-actions">
      <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="primary-button" type="button" disabled={busy}
        onClick={() => void run(() => onApply([...chosen]), true)}>{busy ? "Saving…" : "Apply selection"}</button>
    </div>
  </>;
}
