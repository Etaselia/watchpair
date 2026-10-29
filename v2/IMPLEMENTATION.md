# WatchPair v2 implementation and review record

The [specification](../docs/watchpair-v2-plan.md) is the scope. Each stage ends with a code review, fixes, and recorded verification. A stage is complete only when its workflows are implemented and the relevant checks pass. Packaging and hardware limitations remain explicit; compilation alone is not acceptance.

| Stage | Deliverable | Status |
| --- | --- | --- |
| 1 | Durable coordinator: identity, permissions, ordered queue/timeline commands, readiness, reconnect, shared tracks, watched history | Implemented, reviewed; coordinator and integrated desktop acceptance pass |
| 2 | Local services: multiple transfers, source resolution, selection/policies, library reuse, priorities, limits, storage, diagnostics | Implemented, reviewed; native, GUI and storage acceptance pass |
| 3 | Integrated Qt application: rooms, modern transfer desk, content selection, player, history, settings, keyboard/accessibility flows | Implemented, reviewed and tested on Windows, X11 and Wayland |
| 4 | Verified local file/folder sharing, direct encrypted transfers and separate encrypted relay fallback | Implemented, reviewed; direct/forced-relay and restart tests pass on both platforms |
| 5 | Lifecycle, media matrix, installers, updates, recovery, multi-client end-to-end tests, final UX and code review | Implemented, reviewed; software acceptance passes on both platforms; physical/operator gates below |

## Reviews

### Prototype baseline

Native torrent-to-player tests passed on Windows and Ubuntu. Actual video rendering was inspected on Windows and Linux X11/Wayland. The WSL llvmpipe renderer produced black/corrupted video; softpipe passes. This workaround does not establish physical Linux GPU support. See [prototype evidence](prototype/VALIDATION.md).

### Stage 1 — coordinator (29 October 2026)

Reviewed identity and recovery boundaries, concurrent edits, transactional persistence, status generations, teardown, and large-queue complexity. Fixed during review:

- Room creation and private retry mapping must commit in one transaction.
- Paused readiness reports must not churn revisions or rewrite a large queue.
- Re-adding a source must preserve manual queue ordering; large selections use indexed lookups.
- A delayed old-generation report must not replace current readiness, and ready reports must refer to the target position.
- Heartbeat loss must checkpoint the newly paused generation, rather than an obsolete in-memory reference.
- Replaced WebSockets must not disconnect the replacement, and recovery must revoke existing credentials.
- Shutdown must disconnect watchers while the database is open.

Verification: `npm test --prefix v2/coordinator` — 15 passed, including a real loopback HTTP/WebSocket connection, restart/recovery, distinct 90% coverage, pause/seek barriers, permission checks, a simulated SQL failure, and a 10,000-entry pack. Latest run: [test log](../outputs/v2-coordinator-stage1-tests.log). Desktop/protocol end-to-end tests remain part of stage 3.

### Stage 2 — local acquisition services (29 October 2026)

Implemented one libtorrent session for multiple physical transfers, source resolution (including Nyaa), original manifest indexes, merged room demands, explicit local refusals, Auto/Ask/Never policy, persistent pauses and native resume data, queue order, rate/seeding limits, tracker/peer inspection, recheck/retry, owned storage moves, non-destructive removal, background library hashing, exact-copy reuse, and integrity-checked HTTP acquisition. The existing verified range reader now works with both torrents and identified local files. Native curl enforces interface binding and SOCKS5 remote DNS for HTTP acquisition; TLS verification stays enabled.

Reviewed control persistence, asynchronous removal, source lifetime, folder ownership, interrupted moves, unavailable drives, rate allocation, offline behavior, and startup network privacy. Fixed during review:

- A removed torrent handle can expire before its removal alert; telemetry, scheduling, and reader teardown must tolerate that interval.
- A removed media source must abort pending range requests instead of leaving a dangling reader reference.
- HTTP workers and libtorrent must divide a hard device cap; concurrent HTTP workers share one token bucket.
- A selected bind address must fail closed; HTTP must not silently use the default interface.
- The torrent engine starts without discovery/listeners until persisted network settings are applied. Offline mode closes listeners and disables discovery; proxy mode disables direct discovery and incoming listeners.
- Unavailable or unowned storage remains visible as a repairable transfer. Relocation allocates a new owned child and leaves the old folder untouched.
- Persist move intent before moving; retry incomplete moves without replacing existing destination files. Delete only owned manifest files, preserving unrelated files.
- A folder-allocation retry must never overwrite an existing ownership marker.
- Database initialization failures remove their registered Qt SQL connection, and schema downgrade is refused.

Verification: Windows 10 / Qt 6.12 and Ubuntu 24.04 / Qt 6.4 both pass **9 QtTest results**. The suite exercises real multi-torrent state/restart, verified torrent range reads, storage moves/deletion/repair, exact library identity, reader destruction, bind failure, and two concurrent HTTP downloads under a shared 8 KiB/s device cap. [Windows report](../outputs/v2-local-windows-tests.txt), [Ubuntu report](../outputs/v2-local-linux-tests.log). Application integration, native sharing, cleanup policy, packaging, and the full media matrix remain tracked in stages 3–5.

### Stages 3–4 — integrated desktop and private sharing (29 October 2026)

The Qt application includes room entry/recovery/administration, shared queue and watched history, explicit Join watch, native playback and synchronized tracks, a dense transfer desk with folder selection, device and shared-queue selection scopes, library, settings, diagnostics, and native local-folder publication. Receivers use authenticated direct TCP or a separate opaque HTTPS relay; X25519/HKDF establishes pair keys and AES-GCM protects frames. Merkle proofs verify progressive chunks before disk journaling and exposure to the player; completed copies also receive a full SHA-256 check. Static device keys do not provide forward secrecy. The coordinator is trusted to distribute member public keys.

Self-review fixed stale source/index binding, automatic download refusals, durable HTTP publication, partial verification state, lost command acknowledgments, room-deletion and expired-live-session recovery, unavailable synchronized subtitles, hidden-window video consumption, dirty file-choice drafts, and host selection changes that previously only affected local downloads. Windows rendered UI tests pass creation through playback, background/minimized playback, host queue selection, compact layout, and local playback after forgetting a room. Screenshots are under `outputs/v2/ui-windows/`.

The earlier recovery failures are resolved. The sharing fix bounds reply buffering and retries the same idempotent operation instead of leaving a receiver waiting for a lost response. Timeline clamping at EOF fixes repeated-seek/coverage behavior. Hidden-page frames are consumed with a current render context; Wayland restoration remaps the surface because the protocol does not expose minimized state reliably. Current sharing and playback suites pass on both platforms. Timeouts were not used to disguise lost-response or renderer failures.

### Stage 5 — storage, lifecycle and delivery review (29 October 2026)

Implemented the Storage screen, opt-in age/capacity/free-reserve cleanup with a concrete preview, pins, in-use protection, and owned direct/shared-copy moves. Moves copy and verify on a worker, commit the destination transactionally, then revalidate both copies before removing known old files. Interrupted jobs remain retryable; unrelated files and external originals are preserved. Torrent deletion failures remain recorded for retry. HTTP range resume requires a strong ETag and matching Content-Range; changed origins returning 200 replace the partial copy safely. Automatic room URLs cannot open local paths or private HTTP addresses without an explicit local addition.

Added private per-user profile permissions, authenticated per-profile single-instance IPC, tray controls, startup and invite registration, bounded graceful checkpoints, a browser invite handoff page, relay admission/in-flight memory accounting and operator bandwidth ceilings, self-host container configuration, and an online SQLite backup utility. The coordinator now passes **25 tests**, including a 10,000-file real HTTP request and private online-backup restore. Local-service suites pass **15 QtTest results** on both platforms. Actual Docker/Caddy acceptance passes certificate-verified HTTPS/WSS, separate relay service, restart and backup restore into a fresh volume. No TLS verification bypass was used.

The mixed-transport scheduler, original-offer controls, per-user installer, Ed25519 updates, bounded extraction, stable launcher, SQLite backup and automatic binary/schema rollback are implemented. Completed stage reviews found and fixed:

- Torrent SHA identification now queues before disk preparation and runs at most two preparations/hashes. Waiting pack entries retain no stale paths or move-blocking holds.
- Native file renames use an immutable original manifest snapshot and begin only after durable index/path mapping. Portable naming covers case collisions, reserved names, long paths and Unicode. Removed-kept torrent and HTTP copies are reused safely.
- Explicit Join watch intent survives a transient socket reconnect but is not inherited merely by restarting the app with retained room membership.
- HTTP requests close immediately when their verified source disappears; flushing an error response avoids hidden client connection retries.
- Manual pause, Never policy and device caps remain authoritative across torrent, HTTP, shared media and update traffic. Interface/proxy changes cancel in-flight HTTP work before using the new route.
- Shared track menus disable choices missing from an active/preparing watcher. Paused audio/subtitle/delay changes request an exact native frame refresh; actual ASS and image-subtitle pixels are checked.
- Coalesced render callbacks and a bounded software preview keep the GUI responsive. Qt paint requests redraw the cached native frame even without a new decoder frame, preventing black exposure/capture frames.
- Host file-choice acknowledgments refresh the file tree from the shared queue event, preserving dirty drafts and removing stale saved counts. Readiness cells have an explicit synchronization state.
- Install/update operations use verified fresh staging, private directories and locks. Rollback runs before opening a possibly newer schema and preserves failed database state. The Linux detached launcher closes inherited output pipes and recognizes dead zombie children.
- Linux packaging resolves all Qt dependencies from its configured SDK, rejects mixed Qt versions, includes Wayland decorations and removes build RPATH/RUNPATH values. Missing support libraries were found by standalone tests, not accepted because SDK builds worked.
- Exact dependency sources are collected with receipts: **118 MSYS2 source packages** with detached-signature verification and **182 Ubuntu source packages** with APT/Canonical archive provenance and payload checks, plus matching official Qt modules and ICU source.

## Acceptance evidence

The baseline clean builds passed on both platforms. Subsequent review fixes were rebuilt and tested in the affected suites. Logs below distinguish controlled software acceptance from physical hardware qualification. QtTest result totals include initialization and cleanup rows.

| Check | Evidence |
| --- | --- |
| Coordinator: 25 tests | [report](../outputs/v2-final-coordinator-tests.log) |
| Windows native acquisition, rooms, media binding, models, playback, sharing: all seven CTest suites pass | [report](../outputs/v2-final-tests-windows.log) |
| Linux native acquisition, rooms and sharing | [initial complete pass](../outputs/v2-final-tests-linux.log); its drift failure was isolated and the reviewed playback suite rerun below |
| Reviewed Linux local services, models and playback: all pass | [report](../outputs/v2-reviewed-tests-linux.log), [per-case detail](../outputs/v2-reviewed-tests-linux-details.log) |
| Eight actual libmpv players, explicit Join after restart, reporter handoff, required disconnect/exclusion, history | [Windows](../outputs/v2-reviewed-playback-windows.txt), [Linux](../outputs/v2-reviewed-tests-linux-details.log): raw PTS p95/max spread **41.7 ms** in the controlled loopback test |
| GUI: create/join, nested seasons/extras, host selection, native video, minimize/background/restore, compact layout, local playback after forgetting room, storage | [Windows](../outputs/v2-complete-ui-windows.txt), [X11](../outputs/v2-final-ui-linux-x11.txt), [Wayland](../outputs/v2/ui-linux-wayland-final/results.txt) |
| Native media: H.264, HEVC 10-bit, AV1, PQ/BT.2020 tone mapping, 5.1 audio, multiple tracks, ASS/attached font, PGS, chapters and seeks | [Windows](../outputs/v2-complete-media-windows.txt), [standalone Linux](../outputs/v2-packaged-media-linux-paint-refresh.txt): seven QtTest results per platform |
| Windows media with SDK removed from PATH | [standalone runtime report](../outputs/v2-packaged-media-windows-reviewed.txt); final cached-frame repaint also passes the Windows matrix above |
| Actual installed application launch and automatic crash/runtime/SQLite rollback | [Windows](../outputs/v2-reviewed-installed-windows.txt), [Linux](../outputs/v2-reviewed-installed-linux.txt) |
| Signature tampering/wrong key/version/protocol, archive traversal/link/duplicate rejection, foreign folders, corrupt backup preservation | [Windows delivery](../outputs/v2-packaged-delivery-windows.txt), [Linux delivery core](../outputs/v2-delivery-linux.txt) |
| Actual final signed feed → archive download → checksum/extraction → staged version | [Windows](../outputs/v2-final-signed-transport-windows.txt), [Linux](../outputs/v2-final-signed-transport-linux.txt) |
| Actual Docker/Caddy HTTPS/WSS, separate encrypted relay, restart and fresh-volume backup restore | [report](../outputs/v2-deployment-smoke.log) |

## Practical limits and external release gates

- Tested host: Windows 10 Pro build 19045, Core i7-12700F, RTX 4080 SUPER. The native renderer identifies the NVIDIA GPU in [the media trace](../outputs/v2-media-windows-trace.txt). Windows 11 still needs a physical package trial.
- Linux acceptance uses Ubuntu 24.04 under WSL, Qt 6.12, Mesa softpipe, isolated X11 and Weston Wayland. Physical Intel/AMD/NVIDIA Linux graphics, real displays and the desktop's tray/protocol integration still need a release-candidate trial. llvmpipe failed visual validation; this is not hidden by the softpipe pass.
- Software preview rendering is capped at 640×360; native GPU surfaces keep their full size. Video decoding currently uses software. Hardware decoding needs its own media/platform validation before enabling it.
- Automated multichannel checks verify decoded channels using a null audio sink. Physical speaker routing and calibrated HDR display output require suitable devices; the tone-mapping fixture is a visible decode/render check, not a photometric measurement.
- The 41.7 ms drift result is a controlled loopback measurement. One run under competing package/media workloads reached 667 ms p95; reruns after isolating that load and the reviewed suite pass. This does not establish a WAN latency or saturated-machine guarantee.
- Torrent and verified local-sharing playback are progressive. Direct HTTP media waits for complete SHA-256 verification. No automatic cross-release alignment, native HDR output, bitstream passthrough, voice or browser playback parity is claimed.
- Private sharing uses authenticated direct TCP and relay fallback, without a full ICE traversal stack. Forced relay and container TLS are tested; public restrictive NAT, bandwidth costs and production endpoint behavior need an operator trial. Static sharing keys lack forward secrecy, and the coordinator is trusted to distribute public keys.
- The acceptance bundles pin a QA signing key. On 2026-10-29 these exact packages were manually deployed as a public **alpha trial**, with explicit operator approval, to the existing VPS. Public HTTPS/WSS, both packaged native clients, eight-member presence, relay transport and restart persistence passed. See [the rollout record](deploy/ROLLOUT-2026-10-29.md). Production signing-key custody remains separate; this preview does not claim production-key signing.

The [run guide](README.md) and [distribution procedure](DISTRIBUTION.md) describe reproducible validation and release assembly. v1 source and media remain preserved. Public-release readiness requires closing the physical platform and operator gates above; software implementation is not a claim that inaccessible hardware was tested.
