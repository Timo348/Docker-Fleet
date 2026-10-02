# Docker Fleet

A private, self-hosted dashboard for multiple Docker hosts. Containers, Images and Volumes are merged by default; every resource and action keeps its host ID. The English UI uses compact dark tables, host filters and search. Real Docker inventory, CPU/RAM, lifecycle actions and bounded live logs come through a small agent on each host.

This repository includes the application, agent, configuration examples, schema, tests and Compose templates. Installation in your infrastructure is a separate step. No addresses or credentials in the examples represent a real installation.

Source: [GitHub](https://github.com/Timo348/Docker-Fleet). Container image: [Docker Hub](https://hub.docker.com/r/timo348/docker-fleet), tagged `1.0.0` and `latest`.

For a local trial with two isolated example Docker hosts, see [the preview guide](docs/local-preview.md). The preview uses real Docker data from disposable resources and does not manage your existing containers.

## Architecture

`Browser → existing HTTPS / Authentik proxy → central app → mTLS agent → local Docker socket`

The browser contacts only the central application. Production requires a trusted proxy client certificate, configured identity headers and an allowed username. Each agent accepts only explicitly allowed backend client certificate identities and exposes a fixed API. There is no arbitrary Docker proxy, shell, deletion or prune API.

## First installation

Use Linux with Docker Engine, Docker Compose v2, Bash and OpenSSL. Your existing reverse proxy must support upstream mTLS. The Compose stack does not publish an application port or local-agent port.

1. Copy/clone the project onto the future central host. Work on `main`; no new branch is needed.
2. Create writable runtime directories and one authoritative configuration file:

   ```sh
   mkdir -p runtime/config runtime/data
   cp config.example.yml runtime/config/config.yml
   cp .env.example .env
   bash scripts/certificates.sh init
   ```

3. Edit `.env`: set `DOCKER_GID` to `stat -c '%g' /var/run/docker.sock`; set `PROXY_NETWORK` to the existing reverse proxy network. Edit `runtime/config/config.yml`: set the actual HTTPS `baseUrl`, your allowed Authentik usernames and any host settings. The `.invalid` URLs are deliberate placeholders. The example's second host is disabled. The generated certificate names match the example defaults; changing `APP_TLS_NAME`, `LOCAL_AGENT_TLS_NAME` or client names also requires issuing matching certificates and updating their config references, not just editing `.env`.
4. Give the unprivileged container user access to its own files. These commands apply to the default UID/GID `10001:10001` on Linux:

   ```sh
   sudo chown -R 10001:10001 runtime secrets/backend secrets/clients secrets/agents/local-agent
   sudo chown 10001:10001 secrets/csrf-secret
   sudo chmod 700 runtime/config runtime/data secrets/backend secrets/clients secrets/agents/local-agent
   sudo chmod 600 runtime/config/config.yml secrets/csrf-secret
   ```

   The agent's additional Docker socket group is an administrative trust boundary. Keep `secrets/ca-private` offline; it is never mounted in a container. The proxy needs only its client certificate/key and the public proxy CA, with ownership matching the proxy's actual UID.

5. Configure the existing reverse proxy and Authentik following [the integration guide](docs/auth-proxy.md). Attach that proxy to the configured external Docker network. Set `baseUrl` to the same origin. Do not create a public app port to bypass this route.
6. Build and start only this project when ready to install:

   ```sh
   docker compose config
   docker compose build
   docker compose up -d
   docker compose ps
   docker compose logs --tail 100 app local-agent
   ```

   If the proxy network does not yet exist, arrange it as part of your proxy setup; this project does not change or deploy your existing services.

7. Open the real application URL through Authentik. Confirm an unauthenticated visitor and a disallowed user cannot access it. In Hosts / Settings, test the local host. Add the second host using [the host guide](docs/second-host.md).

## Development and checks

Node.js 24+ is required. Install locked dependencies with `npm ci`. `npm run typecheck`, `npm test` and `npm run build` check types, automated behavior and the production build. `npm run test:integration` provisions isolated Docker hosts and runs integration plus browser checks; standalone `npm run test:e2e` requires the matching isolated fixture environment and `FLEET_TEST_URL`. Read [the verification guide](docs/testing.md) for prerequisites and the distinction between fixtures and real Docker tests. The CI workflow runs typechecking, unit tests, build and an image build on Linux; a workflow file is not evidence that CI has run.

Local development must be explicitly enabled with `ALLOW_DEV_MODE=1`, `auth.mode: development`, an HTTP loopback `baseUrl` and a loopback server bind. Do not use this mode in Compose production. Development fixtures, where used by tests, are isolated from live resource collection.

## Documentation

See [the observed verification results](docs/verification.md) for the exact local checks, real Docker integration and steps still required during installation.

| Guide                                        | Contents                                                             |
| -------------------------------------------- | -------------------------------------------------------------------- |
| [Architecture](docs/architecture.md)         | Components, trust boundaries, implementation approach                |
| [Configuration](docs/configuration.md)       | YAML/JSON, schema, UI saves, conflicts, live versus restart settings |
| [Second Docker host](docs/second-host.md)    | Remote agent, TLS, firewall and first connection                     |
| [Proxy and Authentik](docs/auth-proxy.md)    | Trusted headers, mTLS, authorization, origin/CSRF checks             |
| [Operations](docs/operations.md)             | Secrets, rotation, backup, update, rollback, troubleshooting         |
| [Metrics and logs](docs/metrics-and-logs.md) | CPU/RAM calculation, Docker formats, limits                          |
| [Testing](docs/testing.md)                   | Checks and installation acceptance procedure                         |

The first version supports inventory, monitoring, start/stop/restart and logs. Volume sizes are `Unavailable`; there is no filesystem scan. Cache data is an in-memory last successful snapshot, marked stale after a failed refresh. Hosts are polled independently. Audit files are persistent; the app does not persist full logs, browser cookies or tokens.
