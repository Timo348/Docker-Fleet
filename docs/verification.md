# Verified local results

Verification date: 2 October 2026 (Europe/Berlin). These results refer to this project and an isolated local test environment. No installation, deployment or functional test was performed on the intended infrastructure.

| Check                         | Observed result                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`           | Passed                                                                                                                              |
| `npm test`                    | 48 tests passed across 5 files                                                                                                      |
| `npm run build`               | TypeScript server/agent and production React assets built successfully                                                              |
| `npm run format:check`        | Passed                                                                                                                              |
| `npm audit`                   | 0 reported vulnerabilities at verification time                                                                                     |
| Production Docker image build | Passed as part of the integration harness                                                                                           |
| `npm run test:integration`    | Passed with two isolated Docker daemons, authenticated HTTPS agents and real Docker resources                                       |
| Playwright browser checks     | All 3 passed, including desktop/mobile layout and an expired authentication response                                                |
| Both Compose templates        | `docker compose config --quiet` passed with isolated example environment values                                                     |
| YAML/JSON examples            | Equivalent configuration and both schema-valid                                                                                      |
| Certificate helper            | Initial issuance, second-host issuance, renewal, duplicate-issuance rejection and OpenSSL client/server-purpose verification passed |
| Caddy example                 | Validated in an isolated Caddy 2.11.4 container with test certificates and networking disabled                                      |

The automated tests include genuine TLS handshakes for the central production listener and agent listener. Requests with no client certificate, an unauthorized certificate identity, forbidden user, missing CSRF or foreign origin are denied. Transport tests cover absolute response deadlines, IPv6 connections and redaction of agent errors.

The Docker integration provisions two separate Docker-in-Docker engines on a uniquely named test network. Both run containers named `same-name`, a TTY log container and a same-name volume. The checks exercise start, stop, restart, request deduplication, foreign-host resource rejection, actual stdout/stderr and TTY logs, live stream cancellation, configuration persistence and revision conflicts, an agent outage, stale snapshots and reconnection. Fixture containers and values are restricted to the test harness; production never uses them as monitoring data. The test containers, networks, volumes and test application image were removed afterwards.

The browser checks use those real Docker resources. They exercise tabs, host filtering, search, log pause/filter/download, adding a disabled host, safe HTML log rendering, reauthentication errors and contained mobile overflow. Screenshots are from this explicitly labelled local development test environment: [desktop](screenshots/desktop.png), [mobile](screenshots/mobile.png).

The local tooling was Node.js 24.18.1 and Docker Desktop 4.80.0 with Docker Engine 29.6.1. The isolated test engines reported Docker Engine 29.8.2. The [machine-readable integration report](integration-report.json) records the final observed run. The CI workflow repeats type checking, unit tests, the production build and a Docker image build on GitHub.

## Required at installation

Choose the actual addresses, hostname, proxy network and allowed users; issue and distribute installation credentials; set file ownership and socket GIDs; restrict remote-agent exposure in the host's actual Docker-aware firewall; configure and validate the existing HTTPS/Auth proxy; and verify the real Authentik policy and proxy header replacement. Then repeat the authentication, host connection, action and log acceptance checks on disposable containers in the intended environment. Existing proxy configuration must be backed up and validated before separately authorized changes.

Your DNS, VPN paths, host firewall, actual Docker versions, Authentik session behaviour and existing server services were not validated. No production credentials were used. Configuration is a single-writer file; arbitrary manual editors cannot participate in an atomic compare-and-swap automatically, so stop the application for manual edits as documented.
