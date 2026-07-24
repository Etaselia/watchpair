/**
 * Return the fingerprint belonging to a specific companion file.
 *
 * Older companions only expose the selected file fingerprint at job level, so
 * retain that fallback without assigning it to every file in the torrent.
 */
export function agentFileFingerprint(job, file) {
  return file.fingerprint === undefined
    ? (file.selected ? job.identityFingerprint : null)
    : file.fingerprint;
}

/**
 * Resolve the local companion file that represents the room's logical media.
 * The room source id is only a hint: identical content from another local job
 * is a valid participant-specific playback source.
 */
export function findLocalAgentMedia(jobs, selectedMedia, preferredBinding) {
  if (!selectedMedia) return null;

  const candidates = Object.entries(jobs).flatMap(([sourceId, job]) =>
    job.files.map((file) => ({
      sourceId,
      job,
      file,
      fingerprint: agentFileFingerprint(job, file),
    }))
  );
  const fingerprint = selectedMedia.fingerprint || null;
  const matching = fingerprint
    ? candidates.filter(
      (candidate) =>
        candidate.fingerprint === fingerprint &&
        candidate.file.size === selectedMedia.size
    )
    : candidates.filter(
      (candidate) =>
        candidate.sourceId === selectedMedia.sourceId &&
        (selectedMedia.fileIndex === undefined || candidate.file.index === selectedMedia.fileIndex) &&
        candidate.file.name === selectedMedia.name &&
        candidate.file.size === selectedMedia.size
    );

  if (!matching.length) return null;

  const preferred = preferredBinding && fingerprint === preferredBinding.fingerprint
    ? matching.find(
      (candidate) =>
        candidate.sourceId === preferredBinding.sourceId &&
        candidate.file.index === preferredBinding.fileIndex
    )
    : null;
  const canonical = matching.find(
    (candidate) =>
      candidate.sourceId === selectedMedia.sourceId &&
      (selectedMedia.fileIndex === undefined || candidate.file.index === selectedMedia.fileIndex)
  );

  return preferred
    || canonical
    || matching.sort(
      (left, right) =>
        Number(right.file.ready) - Number(left.file.ready) ||
        Number(right.file.selected) - Number(left.file.selected)
    )[0];
}
