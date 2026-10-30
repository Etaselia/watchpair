# Desktop and coordinator alpha.5 — 2026-10-30

Alpha.5 fixes Upcoming drop placement, detached-player subtitle menus and inherited subtitles when changing episodes. Download approval is a single action directly on each episode. Existing v2 rooms, profiles and media are retained. Install both the coordinator and desktop update for the shared subtitle transition rule.

## Behavior

- Upcoming accepts its own move format during native drag negotiation. The insertion indicator uses the upper or lower half of a row across every column. Multi-selection retains room order; filtered drops preserve hidden entries, including inserting after the last visible episode before the hidden following season. Stable IDs, room identity and the original queue revision guard every move. Negotiation and reordering use linear passes through the queue.
- A pre-created audio/subtitle popup follows the current native window when the player moves into a separate window or fullscreen. The popup retains its input and stacking while open, and prevents idle controls from hiding underneath it.
- Changing episodes resets the native subtitle ID and delay before loading. An inherited embedded selection stays provisional until fresh, matching track inventories arrive from the active watchers. If a required watcher lacks that selection, the shared selection becomes Subtitles off with zero delay. If everyone has it, the room reapplies it after a fresh readiness barrier. External subtitles switch off across episodes. Explicitly selecting an unavailable track within the same episode still pauses and explains the problem.
- Each unapproved Upcoming episode has its own Download button. One click approves exactly that media ID on this device, starts acquisition and removes the button immediately. Available local copies, self-published shares and already approved/automatic downloads have no button. Space and Enter also activate the focused action. Cancelled mouse gestures, repeated clicks and stale room/entry identities cannot approve another episode. The old bottom approval button and confirmation dialog are removed.

## Validation

Regression checks cover real Windows pointer drops, one-click and keyboard acquisition, duplicate names, watched/clear actions, native popup exposure and mouse hit testing, coordinator subtitle transitions, and actual libmpv playback on Windows and Linux. The Wayland popup test uses an isolated nested Weston compositor and XTest input, supplying a real input serial rather than relying on synthetic QWidget clicks.

Versioned validation receipts are retained under `outputs/v2-*`. The test-only Wayland input harness is included under `v2/testing/` in the corresponding-source release.

## Release and limits

Use fresh immutable alpha.5 platform archives and corresponding-source overlay, signed by the same preview feed key as alpha.4. The complete source remains the pinned alpha.2 base plus this release's application/build-input overlay and explicit librsvg source revision, as described by the versioned source reconstruction instructions. Publish source before updating the public desktop feed. Keep the prior coordinator available until health and subtitle-transition smoke tests pass; remove old desktop archives only after native updater verification succeeds.

Physical Windows 11 and physical Linux GPU/audio qualification and restrictive public NAT testing remain open. Direct sharing uses authenticated TCP with optional relay. The earlier loaded-machine history coverage anomaly remains documented; these UI and subtitle fixes do not establish its cause.
