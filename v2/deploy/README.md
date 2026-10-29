# Self-hosting the v2 coordinator and relay

The coordinator stores room metadata and history. The separate relay temporarily forwards encrypted file-copy frames in memory; it never writes media files. Desktop users keep their own copies.

1. Create DNS names for the coordinator and relay pointing at the host. Open TCP 80/443 for Caddy, and optionally UDP 443 for HTTP/3. Keep Node's ports private to the container network.
2. Copy `.env.example` to `.env`, set both names, and generate a fresh 32-byte base64 relay secret. Keep `.env` private and outside version control. Both services must use the same secret.
3. Put the verified desktop packages, checksums and corresponding-source archive in `downloads/`, retaining its index page. Use the release procedure in `../DISTRIBUTION.md` before publishing binaries.
4. From this directory run `docker compose config --quiet`, then `docker compose up --build -d`. Check both HTTPS `/health` endpoints and open a generated invite in a browser and desktop app. Caddy overwrites forwarded client identity before the coordinator trusts the proxy; the coordinator and relay are not published directly.

The default relay ceilings are 10 MiB/s aggregate in each direction and 5 MiB/s per channel, configurable in `.env` (bytes/second; zero unlimited). Buffered data, incoming reservations and in-flight responses share a 64 MiB budget. Frames are capped at 2 MiB, authenticated channels at 1,024, and concurrent sockets at 256. Tickets authorize admission for 60 seconds; a valid slow body can finish after ticket expiry. Uploads use an idle-progress deadline rather than a short total deadline. Pair keys and plaintext media never reach this service. Static client keys do not provide forward secrecy; the coordinator is trusted to distribute member public keys.

## Backup and restore

Use SQLite's online backup API, not a live copy of the database file without its WAL:

```sh
docker compose exec coordinator node dist/src/backup.js /data/backups/room-backup.sqlite
docker compose cp coordinator:/data/backups/room-backup.sqlite ./room-backup.sqlite
```

The utility refuses an existing destination and checks the completed backup. Backups contain room authority and key material; store them privately. Back up `.env` separately, keeping the relay secret private. Rotating that relay secret invalidates outstanding tickets until desktops refresh them.

For recovery, stop the coordinator, preserve its current database/WAL/SHM as a separate recovery set, and restore the verified backup into its data volume as `watchpair-v2.sqlite`, owned by the container's `node` user. Remove only the stopped database's obsolete WAL/SHM after preserving them; do not combine WAL files from a different database generation. Start the coordinator and verify an existing room credential, invite/recovery flow, queue and watched history. The relay has no media database to restore.

Use a separate database and profile from v1. Do not reinterpret v1 local jobs or delete old downloaded media during cutover. Keep the prior v1 release and service backup available until the v2 release candidate passes its acceptance matrix.

The local container/TLS acceptance test passes: certificate-verified HTTPS and WSS through Caddy, two members, queue/history persistence, the separate relay, coordinator restart, and an online backup restored into a fresh volume. Run `../scripts/test-deployment.ps1` to repeat it; the script uses isolated containers, networks, volumes and a temporary local certificate authority. Public DNS, public certificates, real NAT conditions and the production endpoint still require validation during the operator's cutover.

The existing VPS was manually switched to the v2 alpha trial on 2026-10-29. Its public endpoint, native-client checks, artifact hashes and cleanup are recorded in [the rollout report](ROLLOUT-2026-10-29.md). Use [the VPS-specific guide](VPS-ROLLOUT.md) for its port 8443, shared relay origin and small-machine limits. The complete source companion is linked from the download page and hosted with the GitHub prerelease to conserve disk space.
