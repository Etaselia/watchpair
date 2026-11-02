# Desktop alpha.6 — 2026-11-02

This client update adds configurable new-torrent behavior, direct timeline scrubbing, remembered pop-out geometry and pointer-driven player controls. The existing alpha.5 coordinator and protocol 2 remain in service; no server data change is required.

## Behavior

- Settings → Transfers and storage offers Follow room preference (default), Start automatically and Wait for Download for newly added room torrents on this device. Metadata and the episode list may load while payload download waits. The file chooser no longer pre-approves every new torrent regardless of the room preference. Existing transfers, approvals and manual pauses are retained; an explicit checkbox choice takes precedence. Standalone Download selected remains an intentional download action.
- Pressing anywhere on the timeline moves its indicator to that position. Holding the left button follows the pointer until release. The room receives one seek on release, guarded against changes to the room, episode, media or playback generation. Cancelled gestures do not seek another episode. Native keyboard controls remain available.
- The pop-out remembers its normal position and size across returning, closing and app restarts. Fullscreen/maximized dimensions do not overwrite the normal rectangle. Restoring after a monitor change keeps the window within an available work area. Wayland restores size; its compositor controls top-level window placement.
- Moving into the bottom quarter reveals controls. Moving above that boundary hides them after one second; further upper-region movement and playback/buffering refreshes do not restart the delay. Leaving the player hides controls immediately, including while paused. Active control drags, owned popup menus and keyboard editing remain usable; an outside drag hides immediately after its release is delivered. The same presentation surface supplies these rules inline, detached and fullscreen.

## Validation and release

Focused regressions exercise real seeded magnet metadata/payload behavior through the chooser, timeline clicks and outside drags, stale seek cancellation, normal/fullscreen geometry, paused/playing hover zones, keyboard access and native popup interactions. Use fresh immutable alpha.6 archives and a corresponding-source overlay; publish the complete source offer before the signed desktop feed. Keep alpha.5 desktop archives until both native public-feed update tests pass.

The source kit retains the pinned alpha.2 base, the explicitly updated librsvg source revision, and the matched Windows libtorrent build introduced in alpha.4. No dependency update is introduced by this client release. Physical GPU/audio and restrictive public NAT qualification and the previously documented loaded-machine history-coverage anomaly remain separate from these changes.
