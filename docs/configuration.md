# Configuration

`CONFIG_FILE` selects exactly one authoritative file ending in `.yml`, `.yaml` or `.json`. No database or environment variable overrides individual application fields. Compose's `.env` selects mounts/network/certificate identities; the application configuration remains the source of truth for host inventory, polling, authorization and logs. Copy either example, not both.

The two examples have the same structure, validated against [`config.schema.json`](../config.schema.json) plus semantic checks. Version `1` is required. Invalid or unknown fields, duplicate host IDs, missing credential references, invalid origins and inconsistent log bounds are rejected with a field path. YAML duplicate keys and aliases are rejected. Configuration size is capped at 1 MiB.

| Field                                       | Purpose                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`                                   | Configuration schema version, currently `1`                                                                                                |
| `server.host`, `server.port`                | Backend listening interface and internal HTTPS port                                                                                        |
| `server.tls`                                | Backend server certificate/key, trusted proxy CA and allowed proxy certificate CNs                                                         |
| `baseUrl`                                   | Exact externally visible origin, including nonstandard port when used; no subpath/query/credentials                                        |
| `auth.mode`                                 | `proxy` for production; `development` requires explicit loopback opt-in                                                                    |
| `auth.usernameHeader`, `auth.subjectHeader` | Distinct trusted header names; proxy must strip browser input before setting them                                                          |
| `auth.allowedUsers`                         | Exact case-sensitive usernames allowed to use the app and control Docker                                                                   |
| `auth.csrfSecretFile`                       | Separate file with at least 32 secret bytes                                                                                                |
| `credentials`                               | Named TLS client credential references with `caFile`, `certFile`, `keyFile`, optional `serverName`                                         |
| `hosts[]`                                   | Unique `id`, `name`, HTTPS `agentUrl`, `enabled`, `credentialRef`, `timeoutMs`; control actions have at least a 30-second transport budget |
| `polling.inventoryMs`                       | Resource inventory refresh interval                                                                                                        |
| `polling.statsMs`                           | Running-container statistic refresh interval                                                                                               |
| `logs`                                      | Tail, line/buffer bytes, per-user/total streams and stream duration bounds                                                                 |
| `storage.dataDir`                           | Persistent audit directory                                                                                                                 |
| `storage.auditMaxBytes`                     | Rotation threshold for one audit file; current plus one previous file retained                                                             |

`serverName` overrides TLS SNI/hostname verification when the agent URL's address differs from its certificate's DNS SAN. It does not disable verification. Each resource's ID is valid only inside its host ID. Do not reuse host IDs when replacing a host with a different machine; disable the old entry and add a new ID.

## Saving in Hosts / Settings

The UI supports adding/editing/deactivating hosts and testing a saved, enabled host with one of the installed credential references. It can edit polling and the default log tail. Advanced log bounds can be changed in the authoritative file. Credentials are provisioned separately and never entered or displayed as secret contents in the UI.

A save includes the revision fetched by the editor. The service validates the candidate, compares the actual file revision, creates a `0600` lock/temp file in the same directory, synchronizes the temp file and atomically renames it over the authoritative file. The directory is synchronized on POSIX. The active configuration is adopted only after successful persistence. The directory itself must be writable; mounting only the config file prevents reliable atomic replacement.

A stale revision returns a conflict and asks the editor to reload. A malformed manual file is not adopted. If immutable settings changed on disk while the process was running, reload/save reports that restart is required. YAML saves preserve the data but normalize formatting and remove existing comments; the file remains ordinary manually editable YAML.

The `.lock` file coordinates app writers. Arbitrary external editors do not honor that lock; there is necessarily a small race between a revision check and rename. **Stop the app before manual edits**, then validate by starting it again. Do not run multiple app replicas against this file. If a crash leaves a stale `.lock`, stop the app, verify no writer remains, then remove that lock and restart. Never remove a live writer's lock.

## What updates immediately

| Change                                                                                 | How applied                                                                                          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Hosts, enabled flags, display names, addresses/timeouts, existing credential reference | UI save applies immediately; manual edit requires reload or restart                                  |
| Polling and log settings                                                               | UI save/reload applies immediately; changed log limits close existing streams, which can be reopened |
| Server interface/port/TLS, base URL, authentication, credential catalog, storage       | Manual file edit and app restart                                                                     |
| Secret file contents/certificates                                                      | App/agent restart or proxy reload; they are read into process memory                                 |
| Agent bind/socket/limits/trusted client identities                                     | Agent environment change and agent recreation                                                        |

The UI reload action can adopt valid manual changes to editable fields. The app keeps the last valid in-memory configuration on a failed reload/save. Startup with an invalid configuration exits instead of starting unprotected.

## JSON installation

```sh
mkdir -p runtime/config runtime/data
cp config.example.json runtime/config/config.json
```

Set `CONFIG_NAME=config.json` in `.env`, apply the same permissions as YAML, edit your actual installation values and recreate the app. The same UI editor writes JSON back to that file. Keep backups outside the mounted directory to avoid selecting a second file accidentally.

## Development

For local source development only, create a separate config with `server.host: 127.0.0.1`, a local port, `auth.mode: development`, one explicit development username and a separate CSRF file. Launch the backend with `ALLOW_DEV_MODE=1` and `CONFIG_FILE` pointing to that file. Agents still require mTLS. After `npm run build`, serve the frontend from that backend and set `baseUrl` to `http://127.0.0.1:<backend-port>`. For Vite development, the included proxy targets backend port `8080`; start `npm run dev` and set `baseUrl` to the actual Vite browser origin (normally `http://127.0.0.1:5173`) so mutation Origin checks match it. Do not expose this mode through a reverse proxy or publish its port.
