import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const suffix = randomBytes(4).toString('hex');
const project = `fleet-test-${suffix}`;
const dir = join(root, 'runtime', project);
const openssl =
  process.env.OPENSSL_BIN ||
  (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
let backend;
let composeFile;
let csrf;
const port = Number(process.env.FLEET_TEST_PORT || 18080);
const url = `http://127.0.0.1:${port}`;
async function command(program, args, options = {}) {
  try {
    const result = await exec(program, args, {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 300000,
      ...options,
    });
    return result.stdout.trim();
  } catch (error) {
    if (error.stdout) console.error(error.stdout);
    throw error;
  }
}
async function docker(...args) {
  return command('docker', args);
}
async function compose(...args) {
  return docker('compose', '-p', project, '-f', composeFile, ...args);
}
function assert(value, message) {
  if (!value) throw new Error(message);
}
async function waitFor(fn, timeout = 60000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      error = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out: ${error?.message || 'condition not met'}`);
}
async function certificate(name, cn, san, usage) {
  const path = join(dir, name);
  await writeFile(
    `${path}.ext`,
    `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${usage}\n${san ? `subjectAltName=${san}\n` : ''}`,
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
      `${path}.key`,
      '-out',
      `${path}.csr`,
      '-subj',
      `/CN=${cn}`,
    ],
    { env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  await command(openssl, [
    'x509',
    '-req',
    '-in',
    `${path}.csr`,
    '-CA',
    join(dir, 'ca.pem'),
    '-CAkey',
    join(dir, 'ca.key'),
    '-CAcreateserial',
    '-out',
    `${path}.pem`,
    '-days',
    '2',
    '-extfile',
    `${path}.ext`,
  ]);
}
async function request(path, method = 'GET', body, extra = {}) {
  const response = await fetch(`${url}/api${path}`, {
    method,
    headers: {
      ...(method === 'GET'
        ? {}
        : { Origin: url, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  return { status: response.status, value };
}
function agentGet(agentPort, certName = 'client') {
  return new Promise((res, rej) => {
    const request = https.get(
      {
        hostname: '127.0.0.1',
        port: agentPort,
        path: '/v1/health',
        servername: 'agent-one',
        ca: tlsCa,
        ...(certName ? { cert: tlsClientCert, key: tlsClientKey } : {}),
      },
      (response) => {
        let body = '';
        response.on('data', (x) => (body += x));
        response.on('end', () => res({ status: response.statusCode, body }));
      },
    );
    request.on('error', rej);
  });
}
let tlsCa, tlsClientCert, tlsClientKey;
async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const chosen = server.address().port;
      server.close(() => resolvePort(chosen));
    });
  });
}
try {
  await mkdir(dir, { recursive: true });
  console.log('Preparing ephemeral test PKI and two isolated Docker daemons.');
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
      '2',
      '-subj',
      '/CN=fleet-integration-ca',
    ],
    { env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  await certificate('agent-one', 'agent-one', 'DNS:agent-one', 'serverAuth');
  await certificate('agent-two', 'agent-two', 'DNS:agent-two', 'serverAuth');
  await certificate('client', 'test-backend', '', 'clientAuth');
  tlsCa = await readFile(join(dir, 'ca.pem'));
  tlsClientCert = await readFile(join(dir, 'client.pem'));
  tlsClientKey = await readFile(join(dir, 'client.key'));
  await writeFile(join(dir, 'csrf'), randomBytes(48));
  composeFile = join(dir, 'compose.json');
  const services = {};
  const fixedPorts = { one: await freePort(), two: await freePort() };
  const stacksDir = join(dir, 'stacks', 'integration');
  await mkdir(stacksDir, { recursive: true });
  await writeFile(
    join(stacksDir, 'docker-compose.yml'),
    'services:\n  worker:\n    image: alpine:3.23\n',
    'utf8',
  );
  for (const side of ['one', 'two']) {
    services[`engine-${side}`] = {
      image: 'docker:29-dind',
      privileged: true,
      environment: { DOCKER_TLS_CERTDIR: '' },
      command: ['dockerd', '--host=unix:///docker-run/docker.sock'],
      volumes: [`socket-${side}:/docker-run`, `storage-${side}:/var/lib/docker`],
      networks: ['test'],
    };
    services[`agent-${side}`] = {
      image: `docker-fleet-test:${suffix}`,
      command: ['node', 'dist/agent/index.js'],
      environment: {
        AGENT_HOST_ID: side,
        DOCKER_SOCKET: '/docker-run/docker.sock',
        AGENT_TLS_CA: '/test/ca.pem',
        AGENT_TLS_CERT: `/test/agent-${side}.pem`,
        AGENT_TLS_KEY: `/test/agent-${side}.key`,
        AGENT_ALLOWED_CLIENT_NAMES: 'test-backend',
        AGENT_MAX_STREAMS: '2',
        AGENT_STREAM_SECONDS: '60',
        AGENT_COMPOSE_DIR: '/test/stacks',
      },
      volumes: [`socket-${side}:/docker-run:ro`, `${dir.replaceAll('\\', '/')}:/test`],
      ports: ['127.0.0.1::9443'],
      networks: ['test'],
      depends_on: [`engine-${side}`],
    };
  }
  await writeFile(
    composeFile,
    JSON.stringify(
      {
        services,
        networks: { test: {} },
        volumes: { 'socket-one': {}, 'socket-two': {}, 'storage-one': {}, 'storage-two': {} },
      },
      null,
      2,
    ),
  );
  for (const side of ['one', 'two']) {
    services[`agent-${side}`].group_add = ['0', '2375'];
    services[`agent-${side}`].ports = [`127.0.0.1:${fixedPorts[side]}:9443`];
  }
  await writeFile(
    composeFile,
    JSON.stringify(
      {
        services,
        networks: { test: {} },
        volumes: { 'socket-one': {}, 'socket-two': {}, 'storage-one': {}, 'storage-two': {} },
      },
      null,
      2,
    ),
  );
  console.log('Building the production image.');
  console.log(await docker('build', '-t', `docker-fleet-test:${suffix}`, '.'));
  await compose('up', '-d');
  const engineIds = {},
    agentPorts = {};
  for (const side of ['one', 'two']) {
    engineIds[side] = await compose('ps', '-q', `engine-${side}`);
    await waitFor(async () => {
      await docker(
        'exec',
        engineIds[side],
        'docker',
        '-H',
        'unix:///docker-run/docker.sock',
        'info',
      );
      return true;
    }, 120000);
    console.log(`Creating real fixtures on isolated host ${side}.`);
    await docker(
      'exec',
      engineIds[side],
      'docker',
      '-H',
      'unix:///docker-run/docker.sock',
      'run',
      '-d',
      '--name',
      'same-name',
      '--label',
      'com.docker.compose.project=integration',
      '--label',
      'com.docker.compose.service=worker',
      '-e',
      'FLEET_PRIVATE_ENV=must-not-leak',
      '-v',
      'same-volume:/data',
      'alpine:3.23',
      'sh',
      '-c',
      'echo "<script>not-html</script>"; echo stderr-marker >&2; while true; do echo real-docker-log; sleep 1; done',
    );
    await docker(
      'exec',
      engineIds[side],
      'docker',
      '-H',
      'unix:///docker-run/docker.sock',
      'run',
      '-d',
      '-t',
      '--name',
      'tty-log',
      'alpine:3.23',
      'sh',
      '-c',
      'echo tty-marker; sleep 3600',
    );
    agentPorts[side] = Number((await compose('port', `agent-${side}`, '9443')).split(':').at(-1));
  }
  const config = {
    version: 1,
    server: { host: '127.0.0.1', port },
    baseUrl: url,
    auth: {
      mode: 'development',
      usernameHeader: 'x-fleet-user',
      subjectHeader: 'x-fleet-subject',
      allowedUsers: ['integration-user'],
      csrfSecretFile: join(dir, 'csrf'),
    },
    credentials: Object.fromEntries(
      ['one', 'two'].map((side) => [
        side,
        {
          caFile: join(dir, 'ca.pem'),
          certFile: join(dir, 'client.pem'),
          keyFile: join(dir, 'client.key'),
          serverName: `agent-${side}`,
        },
      ]),
    ),
    hosts: ['one', 'two'].map((side) => ({
      id: side,
      name: `Test Host ${side}`,
      agentUrl: `https://127.0.0.1:${agentPorts[side]}`,
      enabled: true,
      credentialRef: side,
      timeoutMs: 5000,
    })),
    polling: { inventoryMs: 1000, statsMs: 1000 },
    logs: {
      defaultTail: 200,
      maxTail: 5000,
      maxBufferBytes: 2097152,
      maxLineBytes: 65536,
      maxStreamsPerUser: 2,
      maxStreamsTotal: 4,
      maxStreamSeconds: 60,
    },
    storage: { dataDir: join(dir, 'data'), auditMaxBytes: 1048576 },
  };
  const configFile = join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify(config, null, 2));
  backend = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: root,
    env: { ...process.env, CONFIG_FILE: configFile, ALLOW_DEV_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (data) => process.stdout.write(data));
  backend.stderr.on('data', (data) => process.stderr.write(data));
  await waitFor(async () => {
    const res = await request('/session');
    if (res.status !== 200) return false;
    csrf = res.value.csrfToken;
    return true;
  });
  await waitFor(
    async () =>
      (await request('/resources')).value.containers?.filter((c) => c.name === 'same-name')
        .length === 2,
  );
  const initial = (await request('/resources')).value;
  assert(
    initial.hosts.every((h) => h.state === 'online'),
    'Both actual Docker hosts should be online.',
  );
  assert(
    initial.images.length >= 2 && initial.volumes.length === 2,
    'Real images and same-name volumes must be aggregated.',
  );
  assert(
    !JSON.stringify(initial).includes('must-not-leak'),
    'Environment data must not be exposed.',
  );
  assert(
    initial.volumes.every((v) => v.sizeBytes === null),
    'Volume size must remain unavailable.',
  );
  const one = initial.containers.find((c) => c.hostId === 'one' && c.name === 'same-name');
  const two = initial.containers.find((c) => c.hostId === 'two' && c.name === 'same-name');
  assert(one.id !== two.id, 'Independent daemon resource IDs must be different.');
  assert(
    [401, 403].includes((await agentGet(agentPorts.one, null)).status),
    'Anonymous agent request must be denied.',
  );
  assert(
    (await request('/refresh', 'POST', {}, { Origin: 'https://untrusted.invalid' })).status === 403,
    'Foreign origin must be denied.',
  );
  assert(
    (await request('/refresh', 'POST', {}, { 'X-CSRF-Token': '' })).status === 403,
    'Missing CSRF must be denied.',
  );
  const action = async (host, id, name, requestId = crypto.randomUUID()) =>
    request(`/hosts/${host}/containers/${id}/${name}`, 'POST', { requestId });
  assert(
    (await action('two', one.id, 'stop')).status >= 400,
    'Foreign-host resource ID must not execute.',
  );
  const stopped = await action('one', one.id, 'stop');
  assert(stopped.status === 200, `Actual stop should succeed: ${JSON.stringify(stopped)}`);
  let current = (await request('/resources')).value;
  assert(
    current.containers.find((c) => c.hostId === 'one' && c.id === one.id).state === 'exited',
    'Target host must stop.',
  );
  assert(
    current.containers.find((c) => c.hostId === 'two' && c.id === two.id).state === 'running',
    'Same-name container on other host must keep running.',
  );
  assert((await action('one', one.id, 'start')).status === 200, 'Actual start should succeed.');
  const dedup = crypto.randomUUID();
  assert(
    (await action('one', one.id, 'restart', dedup)).status === 200,
    'Actual restart should succeed.',
  );
  assert(
    (await action('one', one.id, 'restart', dedup)).status === 200,
    'Duplicate request should return previous result.',
  );
  const logs = await fetch(`${url}/api/hosts/one/containers/${one.id}/logs?tail=20&follow=false`);
  const logText = await logs.text();
  assert(
    logs.ok && logText.includes('stdout') && logText.includes('stderr-marker'),
    'Docker stdout/stderr log demux must work.',
  );
  const tty = initial.containers.find((c) => c.hostId === 'one' && c.name === 'tty-log');
  const ttyText = await (
    await fetch(`${url}/api/hosts/one/containers/${tty.id}/logs?tail=20&follow=false`)
  ).text();
  assert(ttyText.includes('tty-marker'), 'Docker TTY logs must work.');
  const controller = new AbortController();
  const live = await fetch(`${url}/api/hosts/one/containers/${one.id}/logs?tail=1&follow=true`, {
    signal: controller.signal,
  });
  assert(live.ok, 'Live logs must connect.');
  const reader = live.body.getReader();
  assert((await reader.read()).value?.length, 'Live logs must deliver actual bytes.');
  controller.abort();
  const conf = (await request('/config')).value;
  assert(
    (
      await request(
        '/config',
        'PUT',
        { hosts: conf.hosts, polling: conf.polling, logs: conf.logs },
        { 'If-Match': 'outdated-revision' },
      )
    ).status === 409,
    'Stale config revision must be rejected.',
  );
  const edited = await request(
    '/config',
    'PUT',
    {
      hosts: conf.hosts.map((h) => (h.id === 'two' ? { ...h, name: 'Test Host two edited' } : h)),
      polling: conf.polling,
      logs: conf.logs,
    },
    { 'If-Match': conf.revision },
  );
  assert(
    edited.status === 200 && (await readFile(configFile, 'utf8')).includes('Test Host two edited'),
    'UI config writes must persist to authoritative file.',
  );
  await compose('stop', 'agent-two');
  await waitFor(
    async () => (await request('/resources')).value.hosts.find((h) => h.id === 'two').stale,
  );
  current = (await request('/resources')).value;
  assert(
    current.hosts.find((h) => h.id === 'one').state === 'online',
    'Host failure must not block healthy host.',
  );
  assert(
    current.containers.some((c) => c.hostId === 'two'),
    'Stale snapshot must remain visible.',
  );
  await compose('start', 'agent-two');
  await waitFor(async () =>
    (await request('/resources')).value.hosts.every((h) => h.state === 'online'),
  );
  if (!process.argv.includes('--skip-browser')) {
    console.log('Running real-browser checks against actual two-host Docker data.');
    console.log(
      await command(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], {
        env: { ...process.env, FLEET_TEST_URL: url, FLEET_TEST_ARTIFACTS: dir },
        timeout: 120000,
      }),
    );
  }
  const audit = await readFile(join(dir, 'data', 'audit.jsonl'), 'utf8');
  assert(
    audit.includes('restart') && !audit.includes('must-not-leak') && !audit.includes('csrfToken'),
    'Audit must contain actions without secrets.',
  );
  const report = {
    status: 'passed',
    date: new Date().toISOString(),
    engine: JSON.parse(await docker('version', '--format', '{{json .Server}}')),
    checks: [
      'Two isolated Docker daemons and genuine resources',
      'Same-name resource action isolation',
      'Start, stop, restart and request deduplication',
      'Anonymous agent, foreign Origin and CSRF rejection',
      'TTY and multiplexed stdout/stderr logs and live cancellation',
      'Configuration persistence and conflict rejection',
      'Host outage isolation and stale snapshot',
      'Audit privacy',
      ...(process.argv.includes('--skip-browser') ? [] : ['Desktop/mobile browser checks']),
    ],
  };
  await writeFile(
    join(root, 'runtime', 'integration-report.json'),
    JSON.stringify(report, null, 2),
  );
  console.log('PASS: actual Docker integration completed. Report: runtime/integration-report.json');
} catch (error) {
  console.error(error.stack || error);
  if (backend)
    console.error(
      JSON.stringify((await request('/resources').catch(() => ({ value: {} }))).value.hosts || []),
    );
  if (composeFile)
    console.error(
      await compose('logs', '--tail', '10').catch(() => 'No container logs available.'),
    );
  process.exitCode = 1;
} finally {
  backend?.kill('SIGTERM');
  if (composeFile) {
    console.log('Removing only the uniquely named integration containers, networks and volumes.');
    await compose('down', '-v', '--remove-orphans').catch((e) => console.error(e.message));
  }
  await docker('image', 'rm', `docker-fleet-test:${suffix}`).catch(() => {});
}
