# VPS deployment

A newly created semantic major release (`X.0.0`) triggers the `deploy-major`
job in `.github/workflows/release.yml`. Minor, patch, and manually republished
releases do not deploy to the VPS.

The job builds a Linux AMD64 image from the released commit and streams it over
SSH. The repository secret `WATCHPAIR_DEPLOY_SSH_KEY` contains the dedicated
CI private key. `watchpair-known-hosts` pins the VPS host key.

The server uses a locked `watchpair-ci` account whose authorized key forces
`/usr/local/sbin/watchpair-ci-gate`. The gate accepts only a validated major
version and 40-character commit SHA, then invokes the root-owned
`watchpair-ci-deploy` script through its narrow sudo rule.

The deployer boots and checks a candidate container before replacing the live
coordinator. It keeps the previous image as `watchpair:rollback` and restores
it if the public HTTPS health check fails. The Caddy proxy and unrelated
containers are left in place.
