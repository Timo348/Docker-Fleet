# Local preview with example hosts

The preview runs on `http://127.0.0.1:8787` in explicit development mode, marked **LOCAL DEV** in the interface. Two isolated Docker-in-Docker daemons appear as **Demo host 1** and **Demo host 2**. The container names and workloads are examples; their inventory, states, CPU, memory and logs come from real Docker APIs. No connection to production infrastructure is made, and the real machine's Docker socket is never mounted into an agent.

Requirements: Node.js 24 or newer, installed project dependencies, Docker with Compose v2 and Linux-container support, and OpenSSL. On Windows the script detects OpenSSL bundled with Git for Windows under `ProgramFiles`; otherwise OpenSSL must be on `PATH`, or `OPENSSL_BIN` must point to it. Docker must permit privileged containers because the disposable nested Docker engines require them. The disposable agents run as root inside their containers to read privately generated certificate bind mounts on Linux. This mode is intended only for local testing.

```sh
npm ci
npm run build
node scripts/preview.mjs start
node scripts/preview.mjs status
```

`start` builds the application agent image, generates disposable TLS credentials, starts both test engines, creates their example resources, then starts the backend in the background. The browser connects only to the central backend. The two agent ports and the helper's authenticated control port bind to loopback. On Windows the background process opens no terminal window. The first run needs internet access to pull Docker and BusyBox images; subsequent runs can use cached layers.

Both hosts contain containers called `web`, `api` and `worker`. `web` has a working healthcheck, `api` deliberately has a failing healthcheck, and `worker` has no healthcheck. The second host's worker starts stopped, so its usage is unavailable until you start it. Port mappings exist inside the isolated nested engines; they are examples in the dashboard and are not published as services on your computer. Each host also has named example volumes, including an unused volume whose size correctly remains unavailable.

Try host filtering, search, Images, Volumes, logs, start, stop and restart. Identical container names belong to different hosts and can be controlled independently. Log examples include stdout, stderr and HTML-like text that is displayed as text. Hosts/Settings edits persist in the preview's own authoritative configuration file while the preview is running. A new start after stopping recreates the example configuration.

```sh
node scripts/preview.mjs stop
```

`stop` verifies the helper through its authenticated control endpoint rather than blindly terminating a stored PID, then removes only the `docker-fleet-preview` project's labeled containers, network and Docker volumes. This deletes the example containers and their data. The built application image and the ignored `runtime/local-preview/` files remain for diagnosis; they are never publication artifacts. The backend log is `runtime/local-preview/backend.log`. Never commit or share this runtime directory: it contains disposable private keys and a local control token.

On Linux, newly created runtime directories and configuration/control files have restrictive permissions. Windows applies the current user's filesystem ACLs; keep the checkout in a private user directory and do not share the runtime directory. Production secrets and host configuration must be separate from this disposable preview.

To use another local port, set `FLEET_PREVIEW_PORT` before starting. The bind address always remains `127.0.0.1`. To use a published agent image instead of building it, set `FLEET_PREVIEW_IMAGE` to a trusted Docker image reference; the central backend still uses the locally built source. Stop the preview before changing these settings.

If startup fails, the script attempts to clean its own disposable environment. Run `status`, inspect the backend log, then run `stop` before retrying. A lock file protects against simultaneous startups; remove a stale `runtime/local-preview/startup.lock` only after confirming no startup process remains. If Docker Desktop is stopped, start it before cleanup. Cleanup refuses unexpected ownership labels or a changed Compose project. The preview does not replace production authentication, firewall or installation checks.
