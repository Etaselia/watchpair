"use client";

import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  Expand,
  FileVideo2,
  Headphones,
  Link2,
  LoaderCircle,
  Minus,
  MonitorUp,
  Pause,
  Play,
  Plus,
  Radio,
  Subtitles,
  Upload,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  addAgentDownload,
  detectAgent,
  getAgentDownload,
  selectAgentFile,
  type AgentFile,
  type AgentJob,
} from "../lib/agent-client";
import {
  downloadDirectFile,
  fingerprintFile,
  formatBytes,
  formatTime,
  normalizeToken,
  parseSubtitles,
  resolveSharedSource,
  sourceKindLabel,
  type SubtitleCue,
} from "../lib/media";
import {
  type LocalReadiness,
  type PlayerState,
  type WatchSession,
} from "../lib/session-types";

const emptyReadiness = (): LocalReadiness => ({
  ready: false,
  progress: 0,
  status: "Waiting for media",
  fileName: null,
  fileSize: null,
  fingerprint: null,
});

async function sessionRequest(payload: Record<string, unknown>) {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as { session?: WatchSession; error?: string };
  if (!response.ok || !data.session) {
    throw new Error(data.error || "The session could not be updated.");
  }
  return data.session;
}

function sameSelectedFile(session: WatchSession, readiness: LocalReadiness) {
  if (!session.selectedMedia || !readiness.fileName) return true;
  return (
    session.selectedMedia.name === readiness.fileName &&
    session.selectedMedia.size === readiness.fileSize
  );
}

export default function WatchApp() {
  const [deviceId, setDeviceId] = useState("");
  const [displayName, setDisplayName] = useState("Guest");
  const [tokenInput, setTokenInput] = useState("");
  const [roomToken, setRoomToken] = useState("");
  const [joined, setJoined] = useState(false);
  const [session, setSession] = useState<WatchSession | null>(null);
  const [view, setView] = useState<"lobby" | "player">("lobby");
  const [sourceInput, setSourceInput] = useState("");
  const [readiness, setReadiness] = useState<LocalReadiness>(emptyReadiness);
  const [mediaUrl, setMediaUrl] = useState("");
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [subtitleName, setSubtitleName] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | "source" | "file" | "download" | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [agentAvailable, setAgentAvailable] = useState(false);
  const [agentJob, setAgentJob] = useState<AgentJob | null>(null);
  const [connection, setConnection] = useState<"syncing" | "online" | "offline">("syncing");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const readinessRef = useRef(readiness);
  const handledSourceRef = useRef("");
  const mediaUrlRef = useRef("");
  const sessionRef = useRef<WatchSession | null>(null);
  const selectionSentRef = useRef("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      let id = localStorage.getItem("watchpair-device-id");
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("watchpair-device-id", id);
      }

      const savedName = localStorage.getItem("watchpair-display-name") || "Guest";
      const invitedToken = normalizeToken(new URLSearchParams(window.location.search).get("room") || "");
      setDeviceId(id);
      setDisplayName(savedName);
      setRoomToken(invitedToken);
      setTokenInput(invitedToken);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    readinessRef.current = readiness;
  }, [readiness]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    void detectAgent()
      .then(setAgentAvailable)
      .catch(() => setAgentAvailable(false));
  }, []);

  useEffect(() => {
    mediaUrlRef.current = mediaUrl;
  }, [mediaUrl]);

  useEffect(() => {
    return () => {
      if (mediaUrlRef.current.startsWith("blob:")) URL.revokeObjectURL(mediaUrlRef.current);
    };
  }, []);

  const enterSession = useCallback((nextSession: WatchSession) => {
    setSession(nextSession);
    setRoomToken(nextSession.token);
    setJoined(true);
    setError("");
    setConnection("online");
    const url = new URL(window.location.href);
    url.searchParams.set("room", nextSession.token);
    window.history.replaceState({}, "", url);
  }, []);

  const createSession = async () => {
    if (!deviceId) return;
    setBusy("create");
    setError("");
    try {
      localStorage.setItem("watchpair-display-name", displayName.trim() || "Guest");
      const nextSession = await sessionRequest({
        action: "create",
              name: displayName,
      });
      enterSession(nextSession);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the session.");
    } finally {
      setBusy(null);
    }
  };

  const joinSession = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!deviceId) return;
    const token = normalizeToken(tokenInput || roomToken);
    if (token.length !== 9) {
      setError("Enter the complete 8-character session token.");
      return;
    }

    setBusy("join");
    setError("");
    try {
      localStorage.setItem("watchpair-display-name", displayName.trim() || "Guest");
      const nextSession = await sessionRequest({
        action: "join",
        token,
        deviceId,
        name: displayName,
        readiness,
      });
      enterSession(nextSession);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not join the session.");
    } finally {
      setBusy(null);
    }
  };

  const sendAction = useCallback(
    async (action: string, values: Record<string, unknown> = {}) => {
      if (!deviceId || !roomToken) throw new Error("Join a session first.");
      const nextSession = await sessionRequest({
        action,
        token: roomToken,
        deviceId,
        name: displayName,
        ...values,
      });
      setSession(nextSession);
      setConnection("online");
      return nextSession;
    },
    [deviceId, displayName, roomToken]
  );

  useEffect(() => {
    if (!joined || !roomToken) return;

    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/sessions?token=${encodeURIComponent(roomToken)}`, {
          cache: "no-store",
        });
        const data = (await response.json()) as { session?: WatchSession };
        if (active && response.ok && data.session) {
          setSession(data.session);
          setConnection("online");
        } else if (active) {
          setConnection("offline");
        }
      } catch {
        if (active) setConnection("offline");
      }
    };

    void refresh();
    const poll = window.setInterval(refresh, 700);
    return () => {
      active = false;
      window.clearInterval(poll);
    };
  }, [joined, roomToken]);

  useEffect(() => {
    if (!joined || !roomToken || !deviceId) return;

    const heartbeat = () => {
      void sessionRequest({
        action: "heartbeat",
        token: roomToken,
        deviceId,
        name: displayName,
        readiness: readinessRef.current,
      })
        .then((nextSession) => {
          setSession(nextSession);
          setConnection("online");
        })
        .catch(() => setConnection("offline"));
    };

    heartbeat();
    const timer = window.setInterval(heartbeat, 4_000);
    return () => window.clearInterval(timer);
  }, [deviceId, displayName, joined, roomToken]);

  const attachLocalFile = useCallback(
    async (file: File, preferredName = file.name) => {
      setBusy("file");
      setError("");
      try {
        const playableFile =
          preferredName === file.name ? file : new File([file], preferredName, { type: file.type });
        const fingerprint = await fingerprintFile(playableFile);
        const url = URL.createObjectURL(playableFile);
        if (mediaUrlRef.current.startsWith("blob:")) URL.revokeObjectURL(mediaUrlRef.current);
        setMediaUrl(url);

        const nextReadiness: LocalReadiness = {
          ready: true,
          progress: 100,
          status: "Ready to watch",
          fileName: preferredName,
          fileSize: playableFile.size,
          fingerprint,
        };
        setReadiness(nextReadiness);
        readinessRef.current = nextReadiness;
        await sendAction("heartbeat", { readiness: nextReadiness });
        await sendAction("select-media", {
          media: {
            name: preferredName,
            size: playableFile.size,
            fingerprint,
          },
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not prepare that file.");
      } finally {
        setBusy(null);
      }
    },
    [sendAction]
  );

  const onChooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await attachLocalFile(file);
  };

  const onChooseSubtitle = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const cues = parseSubtitles(await file.text());
      if (!cues.length) throw new Error("No subtitle cues were found in that file.");
      setSubtitleCues(cues);
      setSubtitleName(file.name);
      if (session) {
        await sendAction("player", {
          player: { ...session.player, subtitleLanguage: "local" },
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read those subtitles.");
    }
  };

  const addSource = async (event: FormEvent) => {
    event.preventDefault();
    if (!sourceInput.trim()) return;

    setBusy("source");
    setError("");
    try {
      const resolved = await resolveSharedSource(sourceInput);
      await sendAction("source", { source: resolved });
      setSourceInput("");
      setReadiness(emptyReadiness());
      setMediaUrl((current) => {
        if (current.startsWith("blob:")) URL.revokeObjectURL(current);
        return "";
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add that source.");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    const source = session?.source;
    if (!joined || !source || handledSourceRef.current === source.id) return;

    handledSourceRef.current = source.id;
    selectionSentRef.current = "";
    setAgentJob(null);
    const controller = new AbortController();
    const initial: LocalReadiness = {
      ...emptyReadiness(),
      status: "Starting local download",
    };
    setReadiness(initial);
    readinessRef.current = initial;
    setBusy("download");

    const startDownload = async () => {
      try {
        const job = await addAgentDownload(source);
        if (controller.signal.aborted) return;
        setAgentAvailable(true);
        setAgentJob(job);
        setBusy(null);
        return;
      } catch {
        setAgentAvailable(false);
      }

      if (source.kind === "magnet") {
        const next: LocalReadiness = {
          ...emptyReadiness(),
          status: "Open the magnet or start the companion",
        };
        readinessRef.current = next;
        setReadiness(next);
        setBusy(null);
        return;
      }

      try {
        const file = await downloadDirectFile(
          source,
          (progress) => {
            const next: LocalReadiness = {
              ...readinessRef.current,
              ready: false,
              progress: Math.round(progress),
              status: progress >= 100 ? "Verifying file" : "Downloading locally",
            };
            readinessRef.current = next;
            setReadiness(next);
          },
          controller.signal
        );
        if (!controller.signal.aborted) await attachLocalFile(file, source.label);
      } catch (caught) {
        if (controller.signal.aborted) return;
        const next: LocalReadiness = {
          ...emptyReadiness(),
          status: "Choose the downloaded file",
        };
        readinessRef.current = next;
        setReadiness(next);
        setError(
          caught instanceof Error
            ? `Automatic download was blocked. Choose the local file when it is ready. ${caught.message}`
            : "Automatic download was blocked. Choose the local file when it is ready."
        );
      } finally {
        setBusy(null);
      }
    };

    void startDownload();
    return () => controller.abort();
  }, [attachLocalFile, joined, session?.source]);

  useEffect(() => {
    const source = session?.source;
    if (!joined || !source || !agentAvailable) return;

    let active = true;
    const refresh = async () => {
      try {
        let job = await getAgentDownload(source.id);
        if (!active) return;
        setAgentJob(job);

        if (job.status === "error") {
          const next = {
            ...emptyReadiness(),
            status: job.error || "Local download failed",
          };
          readinessRef.current = next;
          setReadiness(next);
          return;
        }

        const currentSession = sessionRef.current;
        let target = currentSession?.selectedMedia
          ? job.files.find(
              (file) =>
                file.name === currentSession.selectedMedia?.name &&
                file.size === currentSession.selectedMedia.size
            )
          : job.files.find((file) => file.selected);

        if (!target && job.files.length) {
          target = [...job.files].sort(
            (left, right) =>
              Number(/\.(mp4|m4v|webm|ogv|mov|mkv)$/i.test(right.name)) -
                Number(/\.(mp4|m4v|webm|ogv|mov|mkv)$/i.test(left.name)) ||
              right.size - left.size
          )[0];
        }

        if (!target) {
          const next = {
            ...emptyReadiness(),
            status: job.status === "metadata" ? "Reading torrent metadata" : "Preparing download",
          };
          readinessRef.current = next;
          setReadiness(next);
          return;
        }

        const selectionKey = `${source.id}:${target.index}`;
        if (!currentSession?.selectedMedia && selectionSentRef.current !== selectionKey) {
          selectionSentRef.current = selectionKey;
          await sendAction("select-media", {
            media: {
              name: target.name,
              size: target.size,
              fingerprint: `${job.infoHash || source.id}:${target.index}:${target.size}`,
            },
          });
        }

        if (job.kind === "magnet" && !target.selected) {
          job = await selectAgentFile(source.id, target.index);
          setAgentJob(job);
          target = job.files.find((file) => file.index === target?.index) || target;
        }

        const isReady = target.progress >= 99.9;
        const next: LocalReadiness = {
          ready: isReady,
          progress: target.progress,
          status: isReady ? "Ready to watch" : job.status === "metadata" ? "Reading torrent metadata" : "Downloading locally",
          fileName: target.name,
          fileSize: target.size,
          fingerprint: `${job.infoHash || source.id}:${target.index}:${target.size}`,
        };
        const becameReady = isReady && !readinessRef.current.ready;
        readinessRef.current = next;
        setReadiness(next);
        if (isReady) setMediaUrl(target.streamUrl);
        if (becameReady) await sendAction("heartbeat", { readiness: next });
      } catch {
        if (active) setAgentAvailable(false);
      }
    };

    void refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [agentAvailable, joined, sendAction, session?.source]);

  const chooseAgentMedia = async (file: AgentFile) => {
    const source = session?.source;
    if (!source || !agentJob) return;
    setBusy("file");
    setError("");
    try {
      if (agentJob.kind === "magnet") {
        const nextJob = await selectAgentFile(source.id, file.index);
        setAgentJob(nextJob);
      }
      selectionSentRef.current = `${source.id}:${file.index}`;
      await sendAction("select-media", {
        media: {
          name: file.name,
          size: file.size,
          fingerprint: `${agentJob.infoHash || source.id}:${file.index}:${file.size}`,
        },
      });
      const next = {
        ...emptyReadiness(),
        progress: file.progress,
        status: "Downloading selected file",
        fileName: file.name,
        fileSize: file.size,
        fingerprint: `${agentJob.infoHash || source.id}:${file.index}:${file.size}`,
      };
      readinessRef.current = next;
      setReadiness(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not select that file.");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!session?.selectedMedia || !readiness.ready || sameSelectedFile(session, readiness)) return;
    const timer = window.setTimeout(() => {
      const next = {
        ...readiness,
        ready: false,
        status: "A different file was selected",
      };
      setReadiness(next);
      readinessRef.current = next;
      void sendAction("heartbeat", { readiness: next });
    }, 0);

    return () => window.clearTimeout(timer);
  }, [readiness, sendAction, session]);

  const copyInvite = async () => {
    if (!session) return;
    const invite = new URL(window.location.href);
    invite.searchParams.set("room", session.token);
    await navigator.clipboard.writeText(invite.toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  };

  const leaveSession = () => {
    setJoined(false);
    setSession(null);
    setRoomToken("");
    setTokenInput("");
    setView("lobby");
    setReadiness(emptyReadiness());
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState({}, "", url);
  };

  const sendPlayerState = useCallback(
    async (player: PlayerState) => {
      await sendAction("player", { player });
    },
    [sendAction]
  );

  const readyParticipants = session?.participants.filter((participant) => participant.ready) ?? [];
  const fingerprints = new Set(
    readyParticipants.map((participant) => participant.fingerprint).filter(Boolean)
  );
  const hasMismatch = fingerprints.size > 1;
  const everyoneReady =
    Boolean(session) &&
    session!.participants.length >= 2 &&
    session!.participants.every((participant) => participant.ready) &&
    !hasMismatch;
  const invitePending = Boolean(roomToken && !joined);

  if (joined && session && view === "player" && mediaUrl) {
    return (
      <SyncedPlayer
        session={session}
        mediaUrl={mediaUrl}
        subtitleCues={subtitleCues}
        subtitleName={subtitleName}
        onBack={() => setView("lobby")}
        onSend={sendPlayerState}
      />
    );
  }

  if (!joined) {
    return (
      <main className="entry-shell">
        <header className="brand-lockup" aria-label="WatchPair">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <span>WatchPair</span>
        </header>

        <section className="entry-panel" aria-labelledby="entry-title">
          <div className="entry-copy">
            <span className="eyebrow">{invitePending ? "Private invite" : "Watch from your own files"}</span>
            <h1 id="entry-title">
              {invitePending ? (
                <>Join session <strong>{roomToken}</strong></>
              ) : (
                <>Same frame. <strong>Same moment.</strong></>
              )}
            </h1>
            <p>
              Pair two browsers, prepare the same video on both devices, and keep every play,
              pause, seek, language, and subtitle choice together.
            </p>
          </div>

          <form className="entry-form" onSubmit={joinSession}>
            <label>
              <span>Your name</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={28}
                placeholder="Guest"
                autoComplete="nickname"
              />
            </label>

            <label>
              <span>Session token</span>
              <input
                className="token-input"
                value={tokenInput}
                onChange={(event) => setTokenInput(normalizeToken(event.target.value))}
                maxLength={9}
                placeholder="ABCD-2345"
                autoComplete="off"
              />
            </label>

            {error && <p className="form-error" role="alert">{error}</p>}

            <div className="entry-actions">
              <button className="primary-button" type="submit" disabled={busy !== null}>
                {busy === "join" ? <LoaderCircle className="spin" /> : <Link2 />}
                Join session
              </button>
              {!invitePending && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={createSession}
                  disabled={busy !== null}
                >
                  {busy === "create" ? <LoaderCircle className="spin" /> : <Plus />}
                  Create new
                </button>
              )}
            </div>
          </form>
        </section>

        <footer className="entry-footer">
          <span><Radio /> Peer presence</span>
          <span><FileVideo2 /> Local media</span>
          <span><Subtitles /> Synced tracks</span>
        </footer>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <button className="brand-lockup compact" onClick={leaveSession} aria-label="Leave session">
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>WatchPair</span>
        </button>

        <div className="session-pill">
          <span className={`connection-dot ${connection}`} />
          <span className="session-label">Session</span>
          <strong>{session?.token}</strong>
          <button className="icon-button" onClick={copyInvite} title="Copy invite link" aria-label="Copy invite link">
            {copied ? <Check /> : <Copy />}
          </button>
        </div>

        <div className="header-people" aria-label="People in session">
          <Users />
          <span>{session?.participants.length ?? 0} online</span>
        </div>
      </header>

      <div className="workspace">
        <section className="source-section" aria-labelledby="source-title">
          <div className="section-heading">
            <div>
              <span className="step-number">01</span>
              <h2 id="source-title">Choose what to watch</h2>
            </div>
            {session?.source && (
              <span className="source-badge">{sourceKindLabel(session.source.kind)}</span>
            )}
          </div>

          <form className="source-form" onSubmit={addSource}>
            <div className="source-input-wrap">
              <Link2 aria-hidden="true" />
              <input
                value={sourceInput}
                onChange={(event) => setSourceInput(event.target.value)}
                placeholder="Paste a magnet, video URL, or page containing one"
                aria-label="Media source"
              />
            </div>
            <button className="primary-button" disabled={busy === "source" || !sourceInput.trim()}>
              {busy === "source" ? <LoaderCircle className="spin" /> : <Plus />}
              Add
            </button>
          </form>

          {session?.source ? (
            <>
              <div className="source-current">
                <div className="file-icon"><Download /></div>
                <div className="source-details">
                  <strong>{session.source.label}</strong>
                  <span>
                    {agentAvailable
                      ? `Companion connected: ${agentJob?.status || "starting"}`
                      : session.source.kind === "direct"
                        ? "Downloading in this browser"
                        : "Companion unavailable: torrent client handoff"}
                  </span>
                </div>
                {session.source.kind === "magnet" && !agentAvailable ? (
                  <a className="secondary-button compact-button" href={session.source.value}>
                    <Download />
                    Open magnet
                  </a>
                ) : agentAvailable ? (
                  <span className="agent-chip"><Radio /> Local agent</span>
                ) : null}
              </div>

              {agentJob && agentJob.files.length > 1 && (
                <div className="agent-files" aria-label="Files in download">
                  {agentJob.files.slice(0, 8).map((file) => {
                    const selected =
                      session.selectedMedia?.name === file.name &&
                      session.selectedMedia.size === file.size;
                    return (
                      <button
                        className={selected ? "selected" : ""}
                        type="button"
                        key={file.index}
                        onClick={() => void chooseAgentMedia(file)}
                      >
                        <FileVideo2 />
                        <span>
                          <strong>{file.name}</strong>
                          <small>{formatBytes(file.size)} / {Math.round(file.progress)}%</small>
                        </span>
                        {selected && <Check />}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <button className="drop-zone" type="button" onClick={() => fileInputRef.current?.click()}>
              <Upload />
              <span><strong>Use a local video</strong> already on this device</span>
            </button>
          )}

          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="video/*,.mkv,.m4v,.mov,.webm"
            onChange={onChooseFile}
          />
          <input
            ref={subtitleInputRef}
            className="sr-only"
            type="file"
            accept=".srt,.vtt,text/vtt"
            onChange={onChooseSubtitle}
          />
        </section>

        <section className="readiness-section" aria-labelledby="readiness-title">
          <div className="section-heading">
            <div>
              <span className="step-number">02</span>
              <h2 id="readiness-title">Get both copies ready</h2>
            </div>
            <span className={`readiness-summary ${everyoneReady ? "ready" : ""}`}>
              {everyoneReady ? "Both ready" : `${readyParticipants.length}/${Math.max(2, session?.participants.length ?? 0)} ready`}
            </span>
          </div>

          <div className="people-grid">
            {session?.participants.map((participant) => {
              const isYou = participant.deviceId === deviceId;
              return (
                <article className="person-row" key={participant.deviceId}>
                  <div className={`avatar ${isYou ? "you" : ""}`}>
                    {participant.name.slice(0, 1).toUpperCase()}
                    <span className={participant.ready ? "ready" : ""} />
                  </div>
                  <div className="person-copy">
                    <div>
                      <strong>{participant.name}</strong>
                      {isYou && <span className="you-label">You</span>}
                    </div>
                    <span>{participant.status}</span>
                    <div className="progress-track" aria-label={`${participant.progress}% complete`}>
                      <span style={{ width: `${participant.progress}%` }} />
                    </div>
                  </div>
                  <div className="person-progress">
                    <strong>{Math.round(participant.progress)}%</strong>
                    <span>{participant.fileSize ? formatBytes(participant.fileSize) : "No file"}</span>
                  </div>
                </article>
              );
            })}

            {(session?.participants.length ?? 0) < 2 && (
              <article className="person-row waiting-row">
                <div className="avatar waiting"><Users /></div>
                <div className="person-copy">
                  <strong>Waiting for your watch partner</strong>
                  <button type="button" onClick={copyInvite}>
                    {copied ? "Invite copied" : "Copy invite link"}
                  </button>
                </div>
              </article>
            )}
          </div>

          {hasMismatch && (
            <p className="mismatch-message" role="alert">
              The ready files do not match. Choose the same release on both devices.
            </p>
          )}

          <div className="local-media-bar">
            <div>
              <FileVideo2 />
              <span>
                <strong>{readiness.fileName || session?.selectedMedia?.name || "No local file selected"}</strong>
                <small>
                  {readiness.fileName
                    ? `${formatBytes(readiness.fileSize)} on this device`
                    : "Select the matching download when it is ready"}
                </small>
              </span>
            </div>
            <div className="local-media-actions">
              {mediaUrl && (
                <button className="secondary-button" type="button" onClick={() => subtitleInputRef.current?.click()}>
                  <Subtitles />
                  {subtitleName || "Add subtitles"}
                </button>
              )}
              <button className="secondary-button" type="button" onClick={() => fileInputRef.current?.click()}>
                <MonitorUp />
                {readiness.fileName ? "Change file" : "Choose file"}
              </button>
            </div>
          </div>
        </section>

        <section className="watch-section" aria-labelledby="watch-title">
          <div className="watch-copy">
            <span className="step-number">03</span>
            <div>
              <h2 id="watch-title">Enter the screening</h2>
              <p>
                {everyoneReady
                  ? "Both files match. Playback controls now belong to everyone."
                  : "The shared player unlocks when both devices report a matching file."}
              </p>
            </div>
          </div>

          <div className="watch-actions">
            {mediaUrl && !everyoneReady && (
              <button className="secondary-button" onClick={() => setView("player")}>
                <Play />
                Preview alone
              </button>
            )}
            <button
              className="watch-button"
              disabled={!everyoneReady || !mediaUrl}
              onClick={() => setView("player")}
            >
              <Play fill="currentColor" />
              Watch together
            </button>
          </div>
        </section>

        {error && (
          <div className="toast-error" role="alert">
            <span>{error}</span>
            <button className="icon-button" onClick={() => setError("")} aria-label="Dismiss error">
              <X />
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

interface SyncedPlayerProps {
  session: WatchSession;
  mediaUrl: string;
  subtitleCues: SubtitleCue[];
  subtitleName: string;
  onBack: () => void;
  onSend: (player: PlayerState) => Promise<void>;
}

function SyncedPlayer({
  session,
  mediaUrl,
  subtitleCues,
  subtitleName,
  onBack,
  onSend,
}: SyncedPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const lastSeqRef = useRef(-1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [subtitleText, setSubtitleText] = useState("");

  const send = useCallback(
    (values: Partial<PlayerState>) => {
      const video = videoRef.current;
      return onSend({
        ...session.player,
        paused: video?.paused ?? session.player.paused,
        position: video?.currentTime ?? session.player.position,
        ...values,
      });
    },
    [onSend, session.player]
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video || lastSeqRef.current === session.seq) return;
    lastSeqRef.current = session.seq;

    const state = session.player;
    const expected = state.paused
      ? state.position
      : state.position + ((Date.now() - state.changedAt) / 1000) * state.playbackRate;
    const drift = expected - video.currentTime;

    if (Math.abs(drift) > 0.85) {
      video.currentTime = Math.max(0, expected);
    } else if (!state.paused && Math.abs(drift) > 0.2) {
      video.playbackRate = Math.max(0.5, Math.min(2, state.playbackRate + Math.sign(drift) * 0.05));
      window.setTimeout(() => {
        if (videoRef.current) videoRef.current.playbackRate = state.playbackRate;
      }, 1_200);
    } else {
      video.playbackRate = state.playbackRate;
    }

    if (state.paused && !video.paused) {
      video.pause();
    } else if (!state.paused && video.paused) {
      void video
        .play()
        .then(() => setNeedsGesture(false))
        .catch(() => setNeedsGesture(true));
    }

    const audioTracks = (video as HTMLVideoElement & {
      audioTracks?: ArrayLike<{ enabled: boolean; language: string; label: string }>;
    }).audioTracks;
    if (audioTracks) {
      Array.from(audioTracks).forEach((track, index) => {
        track.enabled =
          state.audioLanguage === "original"
            ? index === 0
            : track.language === state.audioLanguage || track.label.toLowerCase().includes(state.audioLanguage);
      });
    }
  }, [session.player, session.seq]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      setCurrentTime(video.currentTime);
      setDuration(video.duration || 0);

      if (session.player.subtitleLanguage !== "local" || !subtitleCues.length) {
        setSubtitleText("");
        return;
      }
      const subtitleTime = video.currentTime - session.player.subtitleOffset / 1000;
      const cue = subtitleCues.find((item) => subtitleTime >= item.start && subtitleTime <= item.end);
      setSubtitleText(cue?.text || "");
    }, 120);

    return () => window.clearInterval(timer);
  }, [session.player.subtitleLanguage, session.player.subtitleOffset, subtitleCues]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
      const video = videoRef.current;
      if (!video) return;

      if (event.code === "Space") {
        event.preventDefault();
        void togglePlayback();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const next = Math.max(0, video.currentTime + (event.key === "ArrowRight" ? 10 : -10));
        video.currentTime = next;
        void send({ position: next, paused: video.paused });
      } else if (event.key.toLowerCase() === "f") {
        void playerRef.current?.requestFullscreen();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      await video.play();
      setNeedsGesture(false);
      await send({ paused: false, position: video.currentTime });
    } else {
      video.pause();
      await send({ paused: true, position: video.currentTime });
    }
  }

  const seekTo = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setCurrentTime(value);
  };

  const commitSeek = () => {
    const video = videoRef.current;
    if (video) void send({ position: video.currentTime, paused: video.paused });
  };

  const changeVolume = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = false;
    setMuted(false);
    setVolume(value);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };

  const updateTrack = (key: "audioLanguage" | "subtitleLanguage", value: string) => {
    void send({ [key]: value });
  };

  const updateOffset = (amount: number) => {
    void send({
      subtitleOffset: Math.max(-10_000, Math.min(10_000, session.player.subtitleOffset + amount)),
    });
  };

  const fullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void playerRef.current?.requestFullscreen();
    }
  };

  return (
    <main className="player-shell" ref={playerRef}>
      <video
        ref={videoRef}
        src={mediaUrl}
        playsInline
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setDuration(video.duration);
          const expected = session.player.paused
            ? session.player.position
            : session.player.position + ((Date.now() - session.player.changedAt) / 1000) * session.player.playbackRate;
          video.currentTime = Math.max(0, expected);
        }}
        onEnded={() => void send({ paused: true, position: duration })}
        onDoubleClick={fullscreen}
      />

      <div className="player-topbar">
        <button className="player-icon-button" onClick={onBack} title="Back to lobby" aria-label="Back to lobby">
          <ArrowLeft />
        </button>
        <div className="player-title">
          <strong>{session.selectedMedia?.name || "Local preview"}</strong>
          <span><span className="live-dot" /> Synced with {Math.max(0, session.participants.length - 1)} partner</span>
        </div>
        <div className="player-avatars">
          {session.participants.slice(0, 4).map((participant) => (
            <span key={participant.deviceId} title={participant.name}>
              {participant.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </div>
      </div>

      {subtitleText && (
        <div className="subtitle-overlay">
          {subtitleText.split("\n").map((line, index) => <span key={`${line}-${index}`}>{line}</span>)}
        </div>
      )}

      {needsGesture && (
        <button className="gesture-overlay" onClick={togglePlayback}>
          <Play fill="currentColor" />
          Tap to join playback
        </button>
      )}

      <div className="player-controls">
        <input
          className="timeline"
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={Math.min(currentTime, duration || 0)}
          onChange={(event) => seekTo(Number(event.target.value))}
          onPointerUp={commitSeek}
          onKeyUp={commitSeek}
          aria-label="Seek"
          style={{ "--progress": `${duration ? (currentTime / duration) * 100 : 0}%` } as React.CSSProperties}
        />

        <div className="control-row">
          <div className="control-cluster">
            <button className="player-icon-button main-play" onClick={togglePlayback} title={session.player.paused ? "Play" : "Pause"} aria-label={session.player.paused ? "Play" : "Pause"}>
              {session.player.paused ? <Play fill="currentColor" /> : <Pause fill="currentColor" />}
            </button>
            <button className="player-icon-button" onClick={toggleMute} title={muted ? "Unmute" : "Mute"} aria-label={muted ? "Unmute" : "Mute"}>
              {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </button>
            <input
              className="volume-slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(event) => changeVolume(Number(event.target.value))}
              aria-label="Volume"
            />
            <span className="timecode">{formatTime(currentTime)} <i>/</i> {formatTime(duration)}</span>
          </div>

          <div className="control-cluster right">
            <label className="player-select" title="Playback speed">
              <span className="select-rate">{session.player.playbackRate}x</span>
              <select
                value={session.player.playbackRate}
                onChange={(event) => void send({ playbackRate: Number(event.target.value) })}
                aria-label="Playback speed"
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <option key={rate} value={rate}>{rate}x</option>)}
              </select>
            </label>

            <label className="player-select" title="Audio language">
              <Headphones />
              <select
                value={session.player.audioLanguage}
                onChange={(event) => updateTrack("audioLanguage", event.target.value)}
                aria-label="Audio language"
              >
                <option value="original">Original</option>
                <option value="en">English</option>
                <option value="ja">Japanese</option>
                <option value="de">German</option>
                <option value="fr">French</option>
              </select>
            </label>

            <label className="player-select" title="Subtitles">
              <Subtitles />
              <select
                value={session.player.subtitleLanguage}
                onChange={(event) => updateTrack("subtitleLanguage", event.target.value)}
                aria-label="Subtitles"
              >
                <option value="off">Off</option>
                <option value="local" disabled={!subtitleCues.length}>
                  {subtitleName || "Local subtitle"}
                </option>
              </select>
            </label>

            {session.player.subtitleLanguage === "local" && (
              <div className="offset-control" title="Subtitle timing offset">
                <button onClick={() => updateOffset(-100)} aria-label="Subtitles earlier"><Minus /></button>
                <span>{session.player.subtitleOffset > 0 ? "+" : ""}{session.player.subtitleOffset}ms</span>
                <button onClick={() => updateOffset(100)} aria-label="Subtitles later"><Plus /></button>
              </div>
            )}

            <button className="player-icon-button" onClick={fullscreen} title="Fullscreen" aria-label="Fullscreen">
              <Expand />
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
