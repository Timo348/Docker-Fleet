# Architecture and implementation plan

The central Node.js/TypeScript service serves a React frontend and authenticated JSON/live-log endpoints. Each Linux host runs a separate agent next to Docker. Agents use only their local Unix socket; the central service never mounts a Docker socket. The same image runs either process through an explicit command.

1. Define versioned resource types and validated YAML/JSON configuration. Resource identity is `(hostId, resourceId)` throughout the browser, backend and agent routing.
2. Implement a fixed agent API for inventory, running-container statistics, logs and start/stop/restart. Negotiate the Docker Engine API and restrict log framing, response sizes, request duration and concurrency.
3. Build independent host polling, last-good cache, action serialization, persistent bounded audit and optimistic configuration saves in the central service.
4. Enforce two separate mTLS boundaries: proxy → central app and central app → agent. Apply proxy identity authorization, same-origin read checks and user-bound CSRF tokens for mutations.
5. Provide compact tables for Containers, Images and Volumes, resource-specific controls, live-log cleanup and Hosts / Settings editing. No production monitoring fixture is enabled.
6. Package the components in Compose and verify types, behavior, build and deployment prerequisites. Real-host acceptance remains an installation task.

## Data and connection boundaries

The agent is the chosen Docker access path. Native Docker-over-SSH or daemon mTLS secures transport but grants broad Docker authority to its client. A generic socket proxy adds another API policy layer and still needs DTO filtering, TLS and careful route restrictions; those responsibilities are kept together in this small agent. A Docker authorization plugin could restrict daemon requests, but changes the existing daemon and adds an installation dependency. The fixed agent API requires one small container per host and leaves the daemon configuration unchanged.

Container resource IDs are full 64-character Docker IDs; image IDs are full native image IDs. Docker volumes have no separate opaque ID in their ordinary list model, so their full names are the native IDs. The host ID is always part of the resource key, even if names or image digests match.

| Component     | Can access                                               | Cannot provide to the browser                                                |
| ------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Browser       | Same-origin application API                              | Agent credentials, Docker environment variables                              |
| Reverse proxy | Authentik checks, central HTTPS with client certificate  | Direct agent/Docker access                                                   |
| Central app   | One authoritative config, audit files, configured agents | Private keys and credential file contents                                    |
| Agent         | Local Docker socket and its own TLS files                | Shell execution, arbitrary Docker paths, complete container inspect payloads |

The proxy's certificate is trusted only if its CA and CN match the configured proxy trust list. The app then requires both identity headers and an allowed username. Agent access similarly requires a valid CA chain and an explicitly allowed backend client CN. Dedicated credential pairs can be issued per host.

The agent process still holds administrative Docker authority through its socket. Restricting its exposed API reduces what application callers can request; a compromised agent process or host remains privileged. A read-only socket bind does not make the Docker API read-only. See [Docker's socket security guidance](https://docs.docker.com/engine/security/protect-access/).

Host polls have individual timeouts and locks. An unavailable host changes only its own connection state and cache freshness. Inventory caches are memory-only and disappear on restart; empty results on first startup are not fabricated data. Container statistics can briefly be unavailable until a valid sample pair arrives.

UI action buttons are disabled while that host/container action is pending. Start is offered for created/exited containers; stop/restart require a running container. Tooltips, accessible labels and the progress notice name the container and host without adding a confirmation dialog to every action. Server-side action serialization and request IDs protect against concurrent/duplicate submissions. Stop/restart use Docker's 10-second graceful-stop period; the central mutation transport budget is at least 30 seconds. Docker state is fetched again after an action; a timeout can leave an uncertain outcome that must be checked before retrying. Audit records capture the action/result without bodies, credentials or log content.

Version 1 targets private Linux installations and modest fleets. It is a single central process with a local filesystem configuration and audit store. There is no database, distributed locking, HA, arbitrary stack editing, shell, delete, prune, historical metrics, volume filesystem scan or independent per-user role model. Every allowed user can read and control the configured hosts.
