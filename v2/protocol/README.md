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

The current reporter's consecutive, plausible played intervals contribute distinct coverage. Seeking does not count skipped time. Crossing 90% archives the entry without stopping playback, disabling the file, or changing physical download demands. History is paged separately at `GET /v2/rooms/:roomId/history` with `beforeTime` and `beforeId` cursor fields.

`watchedAt` and history cursors use integer Unix epoch milliseconds. Legacy fractional millisecond records are normalized together with their SQLite ordering values on coordinator startup; records sharing a millisecond are ordered by history ID. Timestamps are never interpreted as Unix seconds. History records retain manifest path and source context so identical episode names remain distinguishable.

`queue.clear` takes `scope: "upcoming" | "watched"`, the current queue revision and a durable operation ID. Every room member may use it after an explicit shared-state confirmation. Upcoming clear deselects only enabled, unwatched entries and preserves watched history. Watched clear atomically removes all watched entries and every history page while preserving Upcoming, sources and media files; playback advances using the same rules as removing its source if its current entry is removed. `historyGeneration` increases on a Watched clear, invalidating cached pages and outstanding history requests. Replays are idempotent and stale revisions are rejected.
