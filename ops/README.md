# VPS deployment

The `Deploy VPS` workflow supports two controlled release paths:

- Scheduled runs use GitHub timezone-aware cron at 04:07 Europe/Vienna, avoiding daylight-saving drift and top-of-hour congestion.
- Scheduled deployment selects the newest published major or minor release (`X.Y.0`) that is not already running.
- Manual workflow dispatches may select any published semantic version, require an explicit approval checkbox, and use the `production-vps` GitHub environment.
- The `production-vps-scheduled` environment is reserved for unattended maintenance-window rollouts.

The workflow builds a Linux AMD64 image from the immutable release tag and streams it over SSH. The repository secret `WATCHPAIR_DEPLOY_SSH_KEY` contains the dedicated CI private key. `watchpair-known-hosts` pins the VPS host key.

The server uses a locked `watchpair-ci` account whose authorized key forces `/usr/local/sbin/watchpair-ci-gate`. The gate accepts only validated `status` and `deploy` commands containing a semantic version and 40-character commit SHA, then invokes the root-owned `watchpair-ci-deploy` script through its narrow sudo rule.

The deployer skips revisions that are already live. For new revisions it boots and checks a candidate container before replacing the live coordinator. It keeps the previous image as `watchpair:rollback` and restores it if the public HTTPS health check fails. The Caddy proxy and unrelated containers are left in place.

When the repository plan supports required reviewers for private repositories, configure them on `production-vps` as an additional approval layer. Keep `production-vps-scheduled` unprotected so eligible releases can roll out automatically at 04:07 Europe/Vienna.
