# Operations

## Secrets and identities

`scripts/certificates.sh` generates two independent trust roots: `proxy-ca` for proxy↔app and `agent-ca` for app↔agent. Leaf certificates have only the appropriate server/client extended key usage and explicit server DNS SANs. A backend client pair is issued per agent credential. All real keys and runtime configuration belong outside Git and are ignored. Keys are not printed by the script.

Run issuance on a trusted machine. Keep CA keys under `secrets/ca-private` offline, with encrypted backups and `0700` directories/`0600` files. Never mount CA private keys in any app, proxy or agent. Only the central app receives agent client keys; only the intended agent receives its server key. Unprivileged runtime processes use UID/GID `10001:10001`; preserve ownership after transferring keys or restoring files. Other PKI tooling may replace the helper script if it produces the same file layout and identities.

The helper defaults to 365-day leaf certificates and 3650-day CAs. `CERT_DAYS`, `CA_DAYS`, `CERT_DIR`, `APP_TLS_NAME`, `LOCAL_AGENT_TLS_NAME`, `PROXY_CLIENT_NAME` are configurable shell environment variables. The helper does not automatically read Compose's `.env`; export matching values or provide them on its command line before issuing/renewing custom identities. Check expiry with `openssl x509 -in <certificate.pem> -noout -enddate`; schedule renewal in your operations tooling before expiry. No automatic certificate renewal or revocation-list service is included.

## Credential rotation

For a routine same-identity leaf renewal, stop the affected app/agent while replacing its files, keep a protected temporary backup, run `bash scripts/certificates.sh renew-agent <credential-id> <actual-SAN-name>`, then distribute the server leaf to the agent and client leaf to the app. Restore permissions and restart both. For proxy/backend TLS leaves, `renew-proxy` reissues the app server and proxy client; restart the app and reload the existing proxy separately. Renewals overwrite those leaf files, not CAs. This simple procedure has a short maintenance interruption.

For an identity/key that may be compromised, use a new credential ID and client CN rather than merely reissuing the same CN. Add the new pair/catalog entry, restart the app, update the agent's allowed client CN list and recreate the agent. Switch the host credential reference and test. Remove the old CN/pair after the transition. An agent accepts no client based solely on being signed by the CA; its allowed CN list is also enforced. For a compromised CA, replace the trust root itself. During a planned CA migration, PEM CA bundles may contain old+new roots for an overlap period; update trust files, restart processes, switch all leaves, then remove the old root and restart again. Revoke a compromised trust root immediately rather than keeping it in an overlap bundle.

To rotate the CSRF secret, replace its file with at least 32 cryptographically random bytes, set `0600` ownership, and recreate the app (`docker compose up -d --force-recreate app`) so the single-file bind mount points to the new file. Existing UI tokens become invalid; reload the UI. No cookies or Authentik tokens are stored by this application.

## Updates and rollback

Record the current Git commit and image ID, back up configuration/audit/secrets, review changes and run checks before installation. Keep a previous image tag (for example your own `docker-fleet:<commit>`) for rollback. Install source updates on `main` unless a separately agreed workflow says otherwise.

```sh
npm ci
npm run check
docker compose build
docker compose up -d
docker compose ps
```

Agents should be updated to the same project version as the app. The application/agent wire protocol is versioned as `/v1`; major incompatible changes require coordinated updates. There are no database migrations in version 1. If an update fails, stop the app, restore the previous authoritative config if its schema changed, set `FLEET_IMAGE` to your retained previous image, and run `docker compose up -d --no-build`. Do the same for agents as needed. Never claim a rollback is safe without checking the version's config compatibility.

The lockfile pins application dependencies. The Dockerfile uses the maintained `node:24-alpine` major tag; pin that base image to a verified digest in your release process if byte-for-byte base reproducibility is needed. Container healthchecks and `restart: unless-stopped` are supplied; a failed Docker healthcheck does not itself restart a container. Monitor both health and process exit state in your existing operations system.

## Backup and restore

Stop the app for a consistent config/audit backup. Back up `runtime/config/`, `runtime/data/`, the deployment `.env` and the required TLS/CSRF files. Include the CA keys in a separate offline encrypted backup. Treat the config as sensitive operational metadata even though secrets are referenced by filename. Audit files contain usernames, host/container IDs and action results. Current and previous audit files are retained under the byte threshold; export them periodically if longer history is required. App logs and Docker logs are not audit backups.

To restore, install the matching code/image, restore exactly one authoritative config at the original mount path, restore key ownership/permissions, restore the proxy network relationship and start agents/app. Re-test authentication and every host before acting on containers. Last-good inventory is not persistent, so hosts repopulate on successful polls after restart.

## Troubleshooting

| Symptom                                         | Check                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| App exits before listening                      | Config field errors, valid schema version, HTTPS base URL, readable key/CA/CSRF files and TLS requirements                                  |
| Permission denied while saving                  | Directory ownership/write permission; mount the directory, not a single file; config `0600`                                                 |
| Config conflict or restart required             | Reload current config, compare manual changes; immutable settings require restart                                                           |
| Config locked after a crash                     | Stop the app, verify no active writer, remove only the stale `.lock`, restart                                                               |
| Proxy returns 502                               | External network membership, app port, certificate SAN/SNI, CA chain and proxy client identity                                              |
| App returns 401/403                             | Valid proxy client certificate/CN, both header names, allowed username, exact Origin and current CSRF token                                 |
| One host offline                                | Internal DNS/route/firewall, HTTPS port, expected agent host ID, agent TLS CA/SAN, backend allowed CN and timeout                           |
| Docker socket unreachable                       | Correct socket path and additional numeric group ID; Docker daemon availability                                                             |
| Logs unavailable                                | Container still exists; logging driver supports reads or dual logging; agent/app stream limits                                              |
| Empty CPU/RAM values                            | Stopped container, failed stats request or insufficient CPU sample; inspect host freshness                                                  |
| Volume size unavailable                         | Expected: version 1 does not scan volume filesystems                                                                                        |
| Healthcheck fails with app otherwise responding | Loopback listener, `HEALTHCHECK_SERVER_NAME` SAN and CA. For independently issued server certs set `HEALTHCHECK_CA_FILE` to their actual CA |

Use `docker compose logs --tail 100 app local-agent` (or the remote agent compose) for bounded process diagnostics. Avoid enabling full proxy/Authentik header tracing when real tokens or cookies may be recorded. Never paste private keys or authentication cookies into bug reports.

## Known limits

Linux Docker Engine API 1.41–1.56 is negotiated; unsupported engines are reported rather than guessed. Very large inventories can exceed the bounded agent response; adjust deployment expectations instead of removing limits blindly. Polling is snapshot-based and does not provide event history. No HA/distributed writer model is supported. The full Docker socket remains trusted administrative access. Log driver/TTY differences can limit stream attribution, and long lines/streams are deliberately truncated or closed. Network disconnects during a lifecycle action can make its final result uncertain; check real state before retrying.
