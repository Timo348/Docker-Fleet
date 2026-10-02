# Verification and installation acceptance

Run checks from the repository root with Node.js 24+ and locked dependencies:

```sh
npm ci
npm run typecheck
npm test
npm run build
docker build --tag docker-fleet:check .
```

Automated test fixtures are isolated test inputs; the running application obtains monitoring values only from configured agents. A successful fixture test does not prove connectivity to your actual servers.

`npm run test:integration` builds the production image and provisions two isolated Docker-in-Docker engines plus mTLS agents, then a loopback development backend. It creates actual disposable same-named containers, images and volumes on those engines; it does not contact installation host addresses or use production credentials. It requires a running Docker daemon able to run privileged test containers, image access, OpenSSL and Chromium for Playwright. Test data and ephemeral certificates are written under ignored `runtime/`; uniquely named test containers/networks/volumes and the test image are removed in a final cleanup step. Install the test browser with `npx playwright install chromium` first. `OPENSSL_BIN` overrides the OpenSSL path; Git's bundled OpenSSL is used by default on Windows.

The integration command runs browser checks by default. `npm run test:integration -- --skip-browser` deliberately skips them and records that narrower scope. `FLEET_TEST_PORT` selects a free loopback backend port when the default `18080` is occupied. `npm run test:e2e` alone needs `FLEET_TEST_URL` pointing to an already running isolated fixture environment with the same test host names/resources; it intentionally skips without that variable. Do not point it at a production installation. Never interpret a skipped browser/Docker check as a passing check. The integration harness writes its successful report to `runtime/integration-report.json`; inspect actual output when a prerequisite prevents completion.

CI runs the core automated checks and Docker image build. CI does not deploy, modify a reverse proxy or access private hosts. Local execution evidence belongs in the final handover/verification record; a checklist alone is not a test result.

## Before accepting a real installation

Use disposable test containers and your own installation values. Check these items after the separate installation:

- Two enabled hosts appear together in **All hosts**, with host labels, independent connection state and last successful refresh.
- Host filter and search narrow Containers, Images and Volumes. Equal names/IDs on different hosts remain separate rows.
- Compare live CPU/RAM to Docker statistics, allowing for sampling time. Stopped containers have unavailable metrics; no healthcheck is not labeled healthy.
- Start/stop/restart a disposable same-named container on each host in turn. Verify only the targeted host changes and audit records include the correct host/container/user/action/result.
- Open historical logs and live follow. Check stdout/stderr attribution, TTY behavior, timestamps, search, pause/resume, copy and bounded download. Closing the view must release the stream.
- Exceed the configured stream count and tail/line/byte/duration bounds in a controlled check; limits must produce a readable result and streams must be released afterwards.
- Shut down only one test agent. The other host remains usable; failed host data becomes stale, and recovery updates its last-success time.
- Save a host edit, inspect the same authoritative YAML/JSON file, restart and confirm persistence. Attempt a stale-editor save after a manual change and expect a conflict. Invalid config must not replace the active valid version.
- Test no session, disallowed user, forged browser identity headers, wrong proxy certificate, wrong agent certificate/CN and wrong Origin/missing CSRF token. Protected reads/actions/streams must be denied.
- Inspect browser API responses and built assets for secret leakage. Credential names may be visible; private key contents, Docker environment variables, cookies/tokens and full inspect payloads must not be returned.
- Check desktop and a narrow viewport: keyboard focus/form labels work, tables scroll inside their own region, and the page itself does not overflow horizontally.
- Back up/restore your configuration, audit and secret files and verify permissions, healthchecks and both host connections after restart.

Any unavailable prerequisite must be reported explicitly with the command that did not run. No real infrastructure acceptance result is asserted by this repository.
