import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, rename, rm, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

// Only this disposable environment is managed. The real host socket is never mounted.
const root = resolve(import.meta.dirname, '..');
const dir = join(root, 'runtime', 'local-preview');
const stateFile = join(dir, 'state.json');
const composeFile = join(dir, 'compose.json');
const project = 'docker-fleet-preview';
const secretFile = join(dir, 'control-token');
const exec = promisify(execFile);
const sides = ['one', 'two'];
const volumeKeys = sides.flatMap((side) => [`socket-${side}`, `storage-${side}`]);
const volumeNames = volumeKeys.map((name) => `${project}_${name}`);
const networkName = `${project}_preview`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function command(program, args, options = {}) {
  try {
    const result = await exec(program, args, {
      cwd: root,
      timeout: 300000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`${program} failed: ${(error.stderr || error.message).slice(-4000)}`);
  }
}
const docker = (...args) => command('docker', args);
const compose = (...args) => docker('compose', '-p', project, '-f', composeFile, ...args);

async function resourceNames() {
  // A successful list distinguishes absent resources from Docker/permission errors.
  // Do not infer "missing" from an arbitrary failed inspect command.
  const [volumes, networks] = await Promise.all([
    docker('volume', 'ls', '-q'),
    docker('network', 'ls', '--format', '{{.Name}}'),
  ]);
  return {
    volumes: new Set(volumes.split(/\r?\n/).filter(Boolean)),
    networks: new Set(networks.split(/\r?\n/).filter(Boolean)),
  };
}

async function jsonFile(path, value) {
  const temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
async function readState() {
  try {
    const value = JSON.parse(await readFile(stateFile, 'utf8'));
    if (
      value.version !== 1 ||
      value.project !== project ||
      value.composeFile !== composeFile ||
      !/^[a-f0-9]{32}$/.test(value.runId)
    )
      throw new Error('Preview state is invalid. Refusing to manage another project.');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function waitFor(condition, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await condition();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out: ${lastError?.message || 'preview not ready'}`);
}
async function freePort(preferred = 0) {
  return new Promise((done, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(preferred, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
}
async function findOpenSSL() {
  if (process.env.OPENSSL_BIN) return process.env.OPENSSL_BIN;
  if (process.platform === 'win32' && process.env.ProgramFiles) {
    const path = join(process.env.ProgramFiles, 'Git', 'usr', 'bin', 'openssl.exe');
    if (
      await access(path, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return path;
  }
  return 'openssl';
}
async function certificates(openssl) {
  const options = { env: { ...process.env, MSYS_NO_PATHCONV: '1' } };
  await command(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'ca.key'),
      '-out',
      join(dir, 'ca.pem'),
      '-days',
      '30',
      '-subj',
      '/CN=docker-fleet-local-preview-ca',
    ],
    options,
  );
  for (const name of ['agent-one', 'agent-two', 'client']) {
    const isClient = name === 'client';
    await writeFile(
      join(dir, `${name}.ext`),
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${isClient ? 'clientAuth' : 'serverAuth'}\n${isClient ? '' : `subjectAltName=DNS:${name}\n`}`,
      { mode: 0o600 },
    );
    await command(
      openssl,
      [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, `${name}.key`),
        '-out',
        join(dir, `${name}.csr`),
        '-subj',
        `/CN=${isClient ? 'local-preview-backend' : name}`,
      ],
      options,
    );
    await command(openssl, [
      'x509',
      '-req',
      '-in',
      join(dir, `${name}.csr`),
      '-CA',
      join(dir, 'ca.pem'),
      '-CAkey',
      join(dir, 'ca.key'),
      '-CAcreateserial',
      '-out',
      join(dir, `${name}.pem`),
      '-days',
      '30',
      '-extfile',
      join(dir, `${name}.ext`),
    ]);
  }
}
function configuration(port, agentPorts) {
  return {
    version: 1,
    server: { host: '127.0.0.1', port },
    baseUrl: `http://127.0.0.1:${port}`,
    auth: {
      mode: 'development',
      usernameHeader: 'x-fleet-user',
      subjectHeader: 'x-fleet-subject',
      allowedUsers: ['local-preview'],
      csrfSecretFile: join(dir, 'csrf'),
    },
    credentials: Object.fromEntries(
      sides.map((side) => [
        side,
        {
          caFile: join(dir, 'ca.pem'),
          certFile: join(dir, 'client.pem'),
          keyFile: join(dir, 'client.key'),
          serverName: `agent-${side}`,
        },
      ]),
    ),
    hosts: sides.map((side, index) => ({
      id: side,
      name: `Demo host ${index + 1}`,
      agentUrl: `https://127.0.0.1:${agentPorts[side]}`,
      enabled: true,
      credentialRef: side,
      timeoutMs: 5000,
    })),
    polling: { inventoryMs: 5000, statsMs: 2000 },
    logs: {
      defaultTail: 200,
      maxTail: 5000,
      maxBufferBytes: 2097152,
      maxLineBytes: 65536,
      maxStreamsPerUser: 2,
      maxStreamsTotal: 4,
      maxStreamSeconds: 300,
    },
    storage: { dataDir: join(dir, 'data'), auditMaxBytes: 1048576 },
  };
}
function composeDocument(image, agentPorts, runId) {
  const services = {};
  const labels = { 'io.docker-fleet.preview': runId };
  for (const side of sides) {
    services[`engine-${side}`] = {
      image: 'docker:29-dind',
      privileged: true,
      restart: 'unless-stopped',
      labels,
      environment: { DOCKER_TLS_CERTDIR: '' },
      command: ['dockerd', '--host=unix:///docker-run/docker.sock'],
      volumes: [`socket-${side}:/docker-run`, `storage-${side}:/var/lib/docker`],
      networks: ['preview'],
      healthcheck: {
        test: ['CMD', 'docker', '-H', 'unix:///docker-run/docker.sock', 'info'],
        interval: '5s',
        timeout: '3s',
        retries: 20,
        start_period: '10s',
      },
    };
    services[`agent-${side}`] = {
      image,
      // The generated key files stay private to the invoking user. Only this
      // disposable agent runs as root to read them on Linux bind mounts.
      user: '0:0',
      restart: 'unless-stopped',
      labels,
      command: ['node', 'dist/agent/index.js'],
      group_add: ['0', '2375'],
      environment: {
        AGENT_HOST_ID: side,
        DOCKER_SOCKET: '/docker-run/docker.sock',
        AGENT_TLS_CA: '/preview/ca.pem',
        AGENT_TLS_CERT: `/preview/agent-${side}.pem`,
        AGENT_TLS_KEY: `/preview/agent-${side}.key`,
        AGENT_ALLOWED_CLIENT_NAMES: 'local-preview-backend',
        AGENT_MAX_STREAMS: '2',
        AGENT_STREAM_SECONDS: '300',
        HEALTHCHECK_SERVER_NAME: `agent-${side}`,
      },
      volumes: [`socket-${side}:/docker-run:ro`, `${dir.replaceAll('\\', '/')}:/preview:ro`],
      ports: [`127.0.0.1:${agentPorts[side]}:9443`],
      networks: ['preview'],
      depends_on: { [`engine-${side}`]: { condition: 'service_healthy' } },
      healthcheck: {
        test: ['CMD', 'node', 'scripts/healthcheck.mjs', 'agent'],
        interval: '10s',
        timeout: '5s',
        retries: 3,
      },
    };
  }
  return {
    services,
    networks: { preview: { labels } },
    volumes: Object.fromEntries(
      sides.flatMap((side) => [
        [`socket-${side}`, { labels }],
        [`storage-${side}`, { labels }],
      ]),
    ),
  };
}
async function createFixtures() {
  for (const side of sides) {
    const engineId = await compose('ps', '-q', `engine-${side}`);
    if (!engineId) throw new Error(`Preview engine ${side} was not created.`);
    const engine = (...args) =>
      docker('exec', engineId, 'docker', '-H', 'unix:///docker-run/docker.sock', ...args);
    await waitFor(async () => !!(await engine('info')), 120000);
    await engine('pull', 'busybox:1.37');
    for (const name of ['web', 'api', 'worker']) {
      const args = [
        'run',
        '-d',
        '--name',
        name,
        '--memory',
        '64m',
        '--memory-swap',
        '64m',
        '--label',
        'com.docker.compose.project=local-preview',
        '--label',
        `com.docker.compose.service=${name}`,
        '--label',
        'io.docker-fleet.example=true',
        '-v',
        `${name}-data:/data`,
      ];
      if (name !== 'worker') {
        args.push('-p', `${name === 'web' ? 8080 : 8081}:80`);
        args.push(
          '--health-cmd',
          name === 'web' ? 'wget -q -O - http://127.0.0.1/' : 'test -f /data/ready',
        );
        args.push('--health-interval', '5s', '--health-timeout', '2s', '--health-retries', '2');
      }
      const script =
        name === 'worker'
          ? 'echo "<script>example text, never executed</script>"; echo "Example worker stderr" >&2; while true; do echo "Example worker heartbeat"; sleep 2; done'
          : `mkdir -p /www; echo "Docker Fleet local example: ${name}" > /www/index.html; echo "Example ${name} started"; busybox httpd -f -p 80 -h /www`;
      await engine(...args, 'busybox:1.37', 'sh', '-c', script);
    }
    await engine('volume', 'create', '--label', 'io.docker-fleet.example=true', 'unused-backup');
    if (side === 'two') await engine('stop', '-t', '2', 'worker');
  }
}
async function control(state, path, method = 'GET') {
  if (!state?.controlPort) return null;
  try {
    const token = await readFile(secretFile, 'utf8');
    const response = await fetch(`http://127.0.0.1:${state.controlPort}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    const result = await response.json();
    if (!response.ok || result.runId !== state.runId || result.pid !== state.pid) return null;
    return result;
  } catch {
    return null;
  }
}
async function removePreviewCompose(state) {
  let doc;
  try {
    doc = JSON.parse(await readFile(composeFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error('Preview Compose file is missing; cleanup refused.');
    throw error;
  }
  const expectedServices = ['engine-one', 'agent-one', 'engine-two', 'agent-two'];
  if (
    Object.keys(doc.services || {})
      .sort()
      .join() !== expectedServices.sort().join()
  )
    throw new Error('Unexpected preview Compose services; cleanup refused.');
  if (
    Object.keys(doc.volumes || {})
      .sort()
      .join() !== [...volumeKeys].sort().join() ||
    Object.keys(doc.networks || {}).join() !== 'preview' ||
    [...Object.values(doc.volumes), ...Object.values(doc.networks)].some(
      (resource) => resource.name !== undefined || resource.external !== undefined,
    )
  )
    throw new Error('Unexpected preview Compose resource names; cleanup refused.');
  for (const value of [
    ...Object.values(doc.services),
    ...Object.values(doc.volumes || {}),
    ...Object.values(doc.networks || {}),
  ]) {
    if (value.labels?.['io.docker-fleet.preview'] !== state.runId)
      throw new Error('Preview ownership label does not match; cleanup refused.');
  }
  // Confirm existing containers belong to this run before asking Compose to remove them.
  const ids = (await compose('ps', '-a', '-q')).split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const actual = JSON.parse(await docker('inspect', '--format', '{{json .Config.Labels}}', id));
    if (
      actual['com.docker.compose.project'] !== project ||
      actual['io.docker-fleet.preview'] !== state.runId
    )
      throw new Error('A preview container has unexpected ownership; cleanup refused.');
  }
  const actualNames = await resourceNames();
  for (const [type, name] of [
    ...volumeNames.filter((name) => actualNames.volumes.has(name)).map((name) => ['volume', name]),
    ...(actualNames.networks.has(networkName) ? [['network', networkName]] : []),
  ]) {
    const labels = JSON.parse(await docker(type, 'inspect', '--format', '{{json .Labels}}', name));
    if (
      labels?.['com.docker.compose.project'] !== project ||
      labels?.['io.docker-fleet.preview'] !== state.runId
    )
      throw new Error(`Preview ${type} ${name} has unexpected ownership; cleanup refused.`);
  }
  await compose('down', '-v', '--remove-orphans');
}
async function stop() {
  const state = await readState();
  if (!state) {
    console.log('No managed local preview was found.');
    return;
  }
  const live = await control(state, '/status');
  if (live) {
    if (!(await control(state, '/stop', 'POST')))
      throw new Error('Preview helper refused shutdown.');
    await waitFor(async () => !(await control(state, '/status')), 15000);
  }
  // No raw PID kill: a stale state file must never terminate a reused, unrelated PID.
  await removePreviewCompose(state);
  await rm(stateFile, { force: true });
  await rm(secretFile, { force: true });
  console.log(
    'Stopped the local preview and removed only its disposable Docker containers, network and volumes.',
  );
}
async function status() {
  const state = await readState();
  const live = await control(state, '/status');
  console.log(
    JSON.stringify(
      {
        running: !!live?.backendRunning,
        url: state?.url || null,
        project: state?.project || null,
        logFile: state ? join(dir, 'backend.log') : null,
        message: live
          ? 'Explicit local development mode with isolated example Docker hosts.'
          : state
            ? 'Preview helper is not reachable; run stop to clean its disposable Docker resources.'
            : 'No local preview is running.',
      },
      null,
      2,
    ),
  );
}
async function start() {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const previous = await readState();
  if (previous) {
    const live = await control(previous, '/status');
    if (live?.backendRunning) return console.log(`Local preview already running: ${previous.url}`);
    throw new Error(
      'A previous preview state exists. Run node scripts/preview.mjs stop before starting again.',
    );
  }
  const lockFile = join(dir, 'startup.lock');
  const lock = await open(lockFile, 'wx', 0o600).catch(() => {
    throw new Error(
      'Another preview startup is running, or a stale runtime/local-preview/startup.lock needs review.',
    );
  });
  let state;
  try {
    const requestedPort = Number(process.env.FLEET_PREVIEW_PORT || 8787);
    if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535)
      throw new Error('FLEET_PREVIEW_PORT must be an integer between 1024 and 65535.');
    const port = await freePort(requestedPort);
    const agentPorts = { one: await freePort(), two: await freePort() };
    await docker('info');
    await docker('compose', 'version');
    const existing = await Promise.all([
      docker('ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`),
      docker('volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`),
      docker('network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`),
    ]);
    if (existing.some(Boolean))
      throw new Error(
        'Docker resources already use the preview project name without managed state. Review them before starting; refusing to adopt existing resources.',
      );
    const names = await resourceNames();
    if (volumeNames.some((name) => names.volumes.has(name)) || names.networks.has(networkName))
      throw new Error(
        'A concrete preview volume or network name already exists, including possibly unlabeled resources. Refusing to adopt existing resources.',
      );
    const openssl = await findOpenSSL();
    await command(openssl, ['version']);
    await access(join(root, 'dist', 'server', 'index.js')).catch(() => {
      throw new Error('Build the application first: npm ci and npm run build.');
    });
    console.log('Preparing disposable TLS credentials and two isolated example Docker hosts.');
    await certificates(openssl);
    await writeFile(join(dir, 'csrf'), randomBytes(48), { mode: 0o600 });
    await writeFile(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    const configFile = join(dir, 'config.json');
    await jsonFile(configFile, configuration(port, agentPorts));
    const image = process.env.FLEET_PREVIEW_IMAGE || 'docker-fleet:preview';
    if (process.env.FLEET_PREVIEW_IMAGE) {
      console.log('Pulling the configured preview image.');
      await docker('pull', image);
    } else {
      console.log('Building docker-fleet:preview from the local project.');
      await docker('build', '-t', image, '.');
    }
    state = {
      version: 1,
      runId: randomBytes(16).toString('hex'),
      project,
      composeFile,
      url: `http://127.0.0.1:${port}`,
      configFile,
      startedAt: new Date().toISOString(),
      pid: null,
      backendPid: null,
      controlPort: null,
    };
    await jsonFile(composeFile, composeDocument(image, agentPorts, state.runId));
    await jsonFile(stateFile, state);
    console.log('Starting isolated Docker engines and TLS agents.');
    await compose('up', '-d', '--wait', '--wait-timeout', '180');
    console.log('Creating real web, api and worker example containers on both hosts.');
    await createFixtures();
    const log = await open(join(dir, 'backend.log'), 'a', 0o600);
    const helper = spawn(process.execPath, [join(root, 'scripts', 'preview.mjs'), '_serve'], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    helper.unref();
    await log.close();
    await waitFor(async () => {
      const current = await readState();
      return (await control(current, '/status'))?.backendRunning;
    });
    await waitFor(async () => {
      const response = await fetch(`${state.url}/api/resources`, {
        signal: AbortSignal.timeout(5000),
      });
      const resources = await response.json();
      return (
        response.ok &&
        resources.hosts?.length === 2 &&
        resources.hosts.every((host) => host.state === 'online') &&
        resources.containers?.length === 6
      );
    });
    console.log(`Local preview ready: ${state.url}`);
    console.log(
      'LOCAL DEV: example names with genuine Docker data. No connection to your infrastructure or real host socket.',
    );
    console.log('Stop with: node scripts/preview.mjs stop');
  } catch (error) {
    if (state) {
      console.error('Preview startup failed; cleaning this disposable environment.');
      await stop().catch((cleanup) => console.error(`Cleanup needs attention: ${cleanup.message}`));
    }
    throw error;
  } finally {
    await lock.close();
    await rm(lockFile, { force: true });
  }
}
async function serve() {
  const state = await readState();
  if (!state || state.pid) throw new Error('No fresh preview state for this helper.');
  const token = Buffer.from(await readFile(secretFile, 'utf8'));
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: root,
    env: { ...process.env, CONFIG_FILE: state.configFile, ALLOW_DEV_MODE: '1' },
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let stopping = false;
  let backendRunning = true;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(8000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    server.close();
    server.closeAllConnections();
  }
  const server = http.createServer((request, response) => {
    const supplied = Buffer.from((request.headers.authorization || '').replace(/^Bearer /, ''));
    if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) {
      response.writeHead(403).end();
      return;
    }
    if (
      !(request.method === 'GET' && request.url === '/status') &&
      !(request.method === 'POST' && request.url === '/stop')
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ pid: process.pid, runId: state.runId, backendRunning }));
    if (request.method === 'POST') setImmediate(() => void shutdown());
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  await jsonFile(stateFile, {
    ...state,
    pid: process.pid,
    backendPid: child.pid,
    controlPort: server.address().port,
  });
  child.once('error', (error) => {
    console.error(`Preview backend failed: ${error.message}`);
    backendRunning = false;
    void shutdown();
  });
  child.once('exit', () => {
    backendRunning = false;
    if (!stopping) void shutdown();
  });
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

try {
  const mode = process.argv[2] || 'start';
  if (mode === 'start') await start();
  else if (mode === 'stop') await stop();
  else if (mode === 'status') await status();
  else if (mode === '_serve') await serve();
  else throw new Error('Usage: node scripts/preview.mjs [start|stop|status]');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
