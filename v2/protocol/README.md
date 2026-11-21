# WatchPair room protocol 2

The coordinator owns room state. Native clients own local acquisition, files, and decoder state. Every `/v2/` request, including the WebSocket upgrade, carries `X-WatchPair-Protocol: 2`. A mismatch returns `426 UPDATE_REQUIRED`. Production connections use HTTPS/WSS; loopback HTTP is used for development tests.

## Credentials and entry

- `POST /v2/rooms` with `{name, memberName, retryKey}` returns `{roomId, memberId, token, invite, recovery}`. `retryKey` is a new 32-byte random base64url secret persisted locally until the result is saved. Repeating this secret request returns the same room/credentials.
- `POST /v2/rooms/:roomId/join` with `{invite, name, retryKey}` returns a scoped member credential. Repeating the private retry key does not create duplicate membership.
- `POST /v2/rooms/:roomId/recover` with `{recovery, retryKey}` restores host control and replaces both the host token and recovery link. A lost response can be retried with the same private key; the old link cannot create another recovery attempt.
- Authenticated requests use `Authorization: Bearer <token>`. Invites and recovery links are separate capabilities, and cannot authenticate ordinary room commands. Capability links use URL fragments, not URL query parameters.

## Commands

`POST /v2/rooms/:roomId/commands` accepts `{operationId, queueRevision?, generation?, command}`. The operation ID is a UUID scoped to the authenticated member. Queue/history edits require the current queue revision; playback/track edits require the current playback generation. Acknowledgments contain `{operationId, revision, queueRevision, replayed}`. Retrying the same operation is idempotent within a 10,000-revision retry window. Reusing an ID for different content is rejected. A conflict requires a current snapshot and a visible user retry; clients do not silently overwrite another member's edits.

Commands and runtime validation are defined in [protocol.ts](../coordinator/src/protocol.ts). Caller-supplied member IDs never determine the actor. Host administration is independently authorized. Link-rotation acknowledgments contain a private `secret` and `secretCurrent` flag; these results must not be broadcast or logged.

## Events and clocks

Connect to `GET /v2/rooms/:roomId/events` with the member headers. The first message is `{type:"snapshot", revision, data}`. Later ordered changes use `{roomId, type:"snapshot"|"state"|"presence"|"deleted", revision, data}`:

- `snapshot` replaces the room/queue view for this connection epoch.
- `state` updates room administration, playback, members, and optionally changed `entries` or appended `history`.
- `presence` updates a single member and is ephemeral; it may share the current room revision.
- `deleted` closes the room. Authentication revocation closes the connection with code 4003; deletion uses 4004; a replaced session uses 4001.

Clients ignore older ordered revisions, reconnect with a new connection epoch, and obtain a fresh snapshot after a gap. HTTP acknowledgments complete pending operations; they are not snapshots and must not overwrite newer events.

Send `{type:"ping",clientTime}` at least once per second. The response echoes `clientTime` with `serverTime`. Estimate the offset using the request midpoint and prefer low-RTT samples. Server time is monotonic epoch-based time for this process. A scheduled playback starts at `startsAt`, then advances from `position` at the shared rate. A paused timeline stays at `position`.

Send validated `status` messages at up to five per second (20-message/sec transport ceiling). Reports identify the current entry and generation, local position/duration, verified media identity, playable readiness/reason, and portable audio/subtitle keys. Stale generations do not change readiness. Only explicit Join watch admits a member to a watch. New watchers stage until ready; existing active watchers block the barrier when unavailable. Connection loss pauses immediately on detection; silent loss uses a three-second heartbeat deadline. Manual room pauses are not undone by readiness.

The current reporter's consecutive, plausible played intervals contribute distinct coverage. Seek jumps add no viewing coverage. An entry archives immediately once distinct coverage exceeds 50%, or when playback switches away at or beyond 80% of the timeline. Archiving during playback keeps the current episode and file demand active. History is paged separately at `GET /v2/rooms/:roomId/history` with `beforeTime` and `beforeId` cursor fields.

`watchedAt` and history cursors use integer Unix epoch milliseconds. Legacy fractional millisecond records are normalized together with their SQLite ordering values on coordinator startup; records sharing a millisecond are ordered by history ID. Timestamps are never interpreted as Unix seconds. History records retain manifest path and source context so identical episode names remain distinguishable.

`queue.clear` takes `scope: "upcoming" | "watched"`, the current queue revision and a durable operation ID. Every room member may use it after an explicit shared-state confirmation. Upcoming clear deselects only enabled, unwatched entries and preserves watched history. Watched clear atomically removes all watched entries and every history page while preserving Upcoming, sources and media files; playback advances using the same rules as removing its source if its current entry is removed. `historyGeneration` increases on a Watched clear, invalidating cached pages and outstanding history requests. Replays are idempotent and stale revisions are rejected.

## Series follows

`GET /v2/version` advertises `seriesFollows`, `seriesFollowFromEntry`, `seriesPendingFollows`, `seriesInteractive`, and `seriesSeasonFromWatched`. With series follows enabled, these routes require a room member's bearer token. Paths are relative to `/v2/rooms/:roomId`.

| Route | Contract |
| --- | --- |
| `GET /series` | Returns the room's follow rules and check times in Unix epoch milliseconds. `pending` can be `setup` while verifying the starting release, `episode` while verifying a later release, or `null`. An active pending rule includes its next verification time. |
| `GET /series/season?year=2026&season=fall` | Previews candidates using watched room entries and the selected MAL season. Returns the latest watched episode per match, entries with existing follows and ambiguous items for review. |
| `POST /series/preview` | Accepts `input` with optional `malId`, `listingId`, or room `entryId`. Send an empty `input` with `entryId` to look up an existing episode by its Nyaa listing or filename. A concrete season and release return a temporary draft bound to the room, member, and selected entry. With `deferMetadata: true`, the coordinator can save a new follow and verify its torrent in the background. Source changes still require a preview with verified metadata. |
| `POST /series` | Confirms a `draftId` with optional `expectedAirAt`, release-numbered `finalEpisode`, and `catalogEpisode` for absolute numbering. Omit `expectedAirAt` to accept the estimate or pass `null` when it is unknown. A draft for an existing entry records it as the starting episode and begins following the next one. |
| `POST /series/:id/actions` | Takes `action` and the current follow `revision`. Actions cover pause, resume, stop, check, skip, link existing, set airtime or finale, replace source, and approve or dismiss an alternate. Only the current host can approve or dismiss an alternate. |
| `POST /series/metadata/:requestId` | A room member who received the matching request can return up to 2 MiB of binary torrent metadata as `application/vnd.watchpair.torrent`. The coordinator checks the info hash from Nyaa and validates the episode before caching or using it. |
| `POST /series/lookup/:requestId` | The requested session can return up to 2 MiB of Nyaa listing HTML or RSS as `application/vnd.watchpair.nyaa`. The coordinator parses the response with the same checks it uses for direct Nyaa requests. |

Desktops advertise `X-WatchPair-Series-Metadata: 1` and `X-WatchPair-Series-Lookup: 1` on the room WebSocket when their local Nyaa preference is enabled. When the initial snapshot advertises `seriesPreference: true`, the desktop can update eligibility on that same connection with `{"type":"series.preference","enabled":false}` or `enabled: true`. Disabling the preference releases any assigned request for another eligible desktop.

A `series.metadata` event requests a Nyaa `.torrent` by numeric `listingId`. A `series.lookup` event requests a listing page by `listingId` or an RSS search by `query` and optional `uploader`. Short-lived request IDs are bound to the selected room session. When `reportFailure` is set, the desktop can send `series.failed` with that `requestId` and an optional `retryAfterMs`. The coordinator tries connected desktops sequentially, once per observed IP address for each request in a round. The cooldown starts at one minute once the round is exhausted. Preview requests with the lookup header can receive `lookupPending: true` while a desktop is working.

`X-WatchPair-Series-Interactive: 1` on a preview requests the device-first route. The coordinator uses the requesting member’s eligible live socket on the same observed network and holds the HTTP response until it can return the verified preview or a bounded error. It gives the requesting device a two-second head start before starting a VPS request. New desktop lookup events may include `timeoutMs`. Old clients retain the pending response and poll flow.

Season review sends `exactWatched: true` with the selected `entryId` and `malId`. The starting listing must match the original torrent info hash, episode and release group. Confirmation checks that the entry is still in Watched. Resuming a stopped follow preserves its cursor and episode ledger, subject to the existing one-live-rule limit.

`X-WatchPair-Series-Events: 1` on the WebSocket subscribes to `series.changed` independently of that device’s fallback eligibility. The event carries the same committed follow list as `GET /series`. Added episodes arrive in the ordinary queue snapshot and use the room's usual download rules.

When the release title search has no eligible match, previewing an existing episode or checking an active follow can retry using the selected MyAnimeList title. The search can omit a trailing season suffix when the release provides an explicit season number. Scheduled additions still require the expected episode, season, group and edition.
