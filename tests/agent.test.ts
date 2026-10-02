import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DockerClient, AgentError } from '../src/agent/docker.js';
import { Inventory, projectContainer } from '../src/agent/inventory.js';
import { calculateStats } from '../src/agent/stats.js';
import { decodeLogLines, safeLogText } from '../src/agent/logs.js';
import { Actions, createAgent, loadAgentOptions, type AgentOptions } from '../src/agent/server.js';

const runningId = 'a'.repeat(64),
  stoppedId = 'b'.repeat(64),
  imageId = 'sha256:' + 'c'.repeat(64);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
function mux(stream: number, text: string): Buffer {
  const payload = Buffer.from(text),
    header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
async function lines(source: Buffer[], tty = false, maxLineBytes = 65536) {
  const output = [];
  for await (const line of decodeLogLines(Readable.from(source), tty, maxLineBytes))
    output.push(line);
  return output;
}

interface MockOptions {
  logs?: Buffer;
  logDriver?: string;
  tty?: boolean;
  badLogs?: boolean;
  api?: string;
  minApi?: string;
  actionDelay?: number;
  followOpen?: boolean;
}
async function dockerFixture(options: MockOptions = {}) {
  const calls: string[] = [];
  let state = 'running',
    startedAt = '2026-01-01T00:00:00.000000000Z',
    mutations = 0,
    closedStreams = 0;
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\docker-fleet-test-${randomUUID()}`
      : path.join(os.tmpdir(), `docker-fleet-${randomUUID()}.sock`);
  const server = http.createServer((request, response) => {
    const original = request.url ?? '';
    calls.push(`${request.method} ${original}`);
    const url = new URL(original.replace(/^\/v1\.\d+/, ''), 'http://docker.invalid');
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/version') {
      send(200, {
        Version: 'test-engine',
        ApiVersion: options.api ?? '1.52',
        MinAPIVersion: options.minApi ?? '1.41',
        Os: 'linux',
      });
      return;
    }
    if (url.pathname === '/containers/json') {
      send(200, [
        {
          Id: runningId,
          Names: ['/duplicate'],
          Image: 'example/app:stable',
          ImageID: imageId,
          State: state,
          Status: 'Up 1 hour',
          Mounts: [{ Type: 'volume', Name: 'data' }],
          Ports: [{ IP: '127.0.0.1', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
        },
        {
          Id: stoppedId,
          Names: ['/stopped'],
          Image: 'example/app:stable',
          ImageID: imageId,
          State: 'exited',
          Status: 'Exited',
          Mounts: [
            { Type: 'volume', Name: 'data' },
            { Type: 'bind', Name: 'other' },
          ],
        },
      ]);
      return;
    }
    if (url.pathname === '/images/json') {
      send(200, [
        { Id: imageId, RepoTags: ['example/app:stable'], Size: 1000, Created: 1700000000 },
      ]);
      return;
    }
    if (url.pathname === '/volumes') {
      send(200, {
        Volumes: [
          {
            Name: 'data',
            Driver: 'local',
            Scope: 'local',
            Labels: { 'com.docker.compose.project': 'example' },
            UsageData: { Size: 123 },
          },
          { Name: 'other', Driver: 'local', Scope: 'local' },
        ],
      });
      return;
    }
    const match = /^\/containers\/([a-f0-9]{64})\/(json|stats|start|stop|restart|logs)$/.exec(
      url.pathname,
    );
    if (!match) {
      send(404, { message: 'Not found' });
      return;
    }
    if (match[2] === 'json') {
      send(200, {
        Id: match[1],
        Name: match[1] === runningId ? '/duplicate' : '/stopped',
        Image: imageId,
        Config: {
          Image: 'example/app:stable',
          Tty: options.tty ?? false,
          Env: ['SECRET=DO_NOT_RETURN'],
          Labels: {
            'com.docker.compose.project': 'example',
            'com.docker.compose.service': 'app',
            secret: 'DO_NOT_RETURN',
          },
        },
        State: {
          Status: match[1] === runningId ? state : 'exited',
          Running: match[1] === runningId && state === 'running',
          StartedAt: startedAt,
        },
        HostConfig: {
          Memory: 0,
          LogConfig: { Type: options.logDriver ?? 'local', Config: { secret: 'DO_NOT_RETURN' } },
        },
      });
      return;
    }
    if (match[2] === 'stats') {
      send(200, {
        cpu_stats: { cpu_usage: { total_usage: 30 }, system_cpu_usage: 3000, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 20 }, system_cpu_usage: 2000 },
        memory_stats: { usage: 1024, limit: 4096, stats: { inactive_file: 256 } },
      });
      return;
    }
    if (match[2] === 'logs') {
      if (options.badLogs) {
        send(500, {
          message: 'configured logging driver does not support reading PASSWORD=SECRET',
        });
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
      const payload = options.logs ?? mux(1, '2026-01-01T00:00:00.000000001Z hello\n');
      if (options.followOpen && url.searchParams.get('follow') === 'true') {
        response.write(payload);
        response.on('close', () => {
          closedStreams++;
        });
      } else response.end(payload);
      return;
    }
    if (request.method !== 'POST') {
      send(405, {});
      return;
    }
    mutations++;
    setTimeout(() => {
      if (match[2] === 'stop') state = 'exited';
      else {
        state = 'running';
        startedAt = `2026-01-01T00:00:${String(mutations).padStart(2, '0')}.000000000Z`;
      }
      response.writeHead(204);
      response.end();
    }, options.actionDelay ?? 0);
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const docker = new DockerClient({ socketPath, timeoutMs: 2000 });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        docker.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return {
    docker,
    calls,
    get mutations() {
      return mutations;
    },
    get closedStreams() {
      return closedStreams;
    },
    socketPath,
  };
}

function settings(socketPath: string): AgentOptions {
  return {
    hostId: 'host-a',
    bind: '127.0.0.1',
    port: 0,
    dockerSocket: socketPath,
    development: true,
    maxStreams: 4,
    maxLogBytes: 2_097_152,
    maxLineBytes: 65536,
    maxTail: 5000,
    streamSeconds: 600,
  };
}
async function startAgent(options: AgentOptions) {
  const agent = createAgent(options);
  agent.server.listen(0, '127.0.0.1');
  await once(agent.server, 'listening');
  cleanup.push(agent.close);
  const address = agent.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener.');
  return {
    ...agent,
    baseUrl: `${options.development ? 'http' : 'https'}://127.0.0.1:${address.port}`,
  };
}

describe('agent Linux resource calculations', () => {
  it('uses Docker CPU semantics and cgroup v1 cache, without clamping multicore CPU to 100%', () => {
    expect(
      calculateStats(runningId, {
        cpu_stats: { cpu_usage: { total_usage: 400 }, system_cpu_usage: 1200, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 1000 },
        memory_stats: {
          usage: 1000,
          limit: 2000,
          stats: { total_inactive_file: 200, inactive_file: 10 },
        },
      }),
    ).toEqual({ id: runningId, cpuPercent: 200, memoryBytes: 800, memoryLimitBytes: 2000 });
  });
  it('supports cgroup v2 and distinguishes missing measurements from measured zero', () => {
    const result = calculateStats(runningId, {
      cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 200, online_cpus: 2 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 100 },
      memory_stats: { usage: 100, stats: { inactive_file: 20 } },
    });
    expect(result).toMatchObject({ cpuPercent: 0, memoryBytes: 80, memoryLimitBytes: null });
    expect(calculateStats(runningId, {})).toMatchObject({
      cpuPercent: null,
      memoryBytes: null,
      memoryLimitBytes: null,
    });
  });
  it('does not fabricate an initial sample, negative counters or negative memory', () => {
    expect(
      calculateStats(runningId, {
        cpu_stats: { cpu_usage: { total_usage: 20 }, system_cpu_usage: 300, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      }).cpuPercent,
    ).toBeNull();
    expect(
      calculateStats(runningId, {
        cpu_stats: { cpu_usage: { total_usage: 20 }, system_cpu_usage: 300, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 30 }, system_cpu_usage: 200 },
        memory_stats: { usage: 100, stats: { inactive_file: 200 } },
      }),
    ).toMatchObject({ cpuPercent: null, memoryBytes: 100 });
  });
});

describe('agent safe projections and Docker access', () => {
  it('does not report healthy without a healthcheck or expose environment/labels/driver options', async () => {
    const fixture = await dockerFixture();
    const inventory = new Inventory(fixture.docker, 'host-a');
    const snapshot = await inventory.snapshot();
    expect(snapshot.containers[0]).toMatchObject({
      id: runningId,
      name: 'duplicate',
      hostId: 'host-a',
      health: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain('DO_NOT_RETURN');
    expect(snapshot.images[0]?.containerIds).toEqual([runningId, stoppedId]);
    expect(snapshot.volumes[0]).toMatchObject({
      id: 'data',
      name: 'data',
      sizeBytes: null,
      containerIds: [runningId, stoppedId],
    });
    expect(snapshot.volumes[1]?.containerIds).toEqual([]);
    expect(
      fixture.calls.every(
        (call) =>
          !call.includes('system/df') && !call.includes('exec') && !call.includes('archive'),
      ),
    ).toBe(true);
    expect(fixture.calls).toContain('GET /v1.52/containers/json?all=true');
    const stats = await inventory.stats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ id: runningId, memoryBytes: 768 });
    expect(fixture.calls.some((call) => call.includes(`/containers/${stoppedId}/stats`))).toBe(
      false,
    );
  });
  it('keeps the same native resource IDs distinct by host and recognizes explicit health only', () => {
    const a = projectContainer(
      { Id: runningId },
      { Id: runningId, State: { Health: { Status: 'healthy' } } },
      'a',
    );
    const b = projectContainer({ Id: runningId }, { Id: runningId }, 'b');
    expect(a.id).toBe(b.id);
    expect(a.hostId).not.toBe(b.hostId);
    expect(a.health).toBe('healthy');
    expect(b.health).toBeNull();
  });
  it('rejects incompatible Engine APIs before querying containers', async () => {
    const fixture = await dockerFixture({ api: '1.40', minApi: '1.24' });
    await expect(new Inventory(fixture.docker, 'host-a').snapshot()).rejects.toMatchObject({
      code: 'ENGINE_VERSION_UNSUPPORTED',
    });
    expect(fixture.calls.filter((call) => !call.endsWith('/version'))).toHaveLength(0);
  });
  it('bounds decoded JSON responses', async () => {
    const fixture = await dockerFixture();
    const bounded = new DockerClient({ socketPath: fixture.socketPath, maxResponseBytes: 32 });
    cleanup.push(() => bounded.close());
    await expect(bounded.version()).rejects.toMatchObject({ code: 'RESPONSE_LIMIT_EXCEEDED' });
  });
});

describe('agent log framing and resource limits', () => {
  it('demultiplexes frames split across headers, timestamps, UTF-8 and line boundaries', async () => {
    const combined = Buffer.concat([
      mux(1, '2026-01-01T00:00:00.123456789Z Grü'),
      mux(2, '2026-01-01T00:00:00Z warning\n'),
      mux(1, 'ße\n'),
    ]);
    const result = await lines(Array.from(combined, (byte) => Buffer.from([byte])));
    expect(result).toEqual([
      { stream: 'stderr', timestamp: '2026-01-01T00:00:00Z', text: 'warning' },
      { stream: 'stdout', timestamp: '2026-01-01T00:00:00.123456789Z', text: 'Grüße' },
    ]);
  });
  it('reads TTY as raw text, neutralizes terminal sequences and preserves HTML as literal text', async () => {
    const result = await lines(
      [Buffer.from('\u001b[31m<script>alert(1)</script>\u001b[0m\n')],
      true,
    );
    expect(result).toEqual([{ stream: 'console', text: '<script>alert(1)</script>' }]);
    expect(safeLogText('hi\u001b]52;c;SECRET\u0007there\u0000')).toBe('hithere');
  });
  it('caps oversized partial lines and rejects truncated or absurd frame headers', async () => {
    expect(await lines([mux(1, 'abcdef'), mux(1, 'ghijkl\nnext\n')], false, 4)).toEqual([
      { stream: 'stdout', text: 'abcd', truncated: true },
      { stream: 'stdout', text: 'next' },
    ]);
    await expect(lines([mux(1, 'hello').subarray(0, 10)])).rejects.toMatchObject({
      code: 'LOG_FORMAT_INVALID',
    });
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(0xffffffff, 4);
    await expect(lines([header])).rejects.toMatchObject({ code: 'LOG_FRAME_LIMIT' });
  });
  it('returns NDJSON and readable pre-header errors for disabled/unsupported drivers', async () => {
    const fixture = await dockerFixture();
    const agent = await startAgent(settings(fixture.socketPath));
    const response = await fetch(
      `${agent.baseUrl}/v1/containers/${runningId}/logs?tail=20&follow=false`,
    );
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(JSON.parse((await response.text()).trim())).toEqual({
      stream: 'stdout',
      text: 'hello',
      timestamp: '2026-01-01T00:00:00.000000001Z',
    });
    const disabledFixture = await dockerFixture({ logDriver: 'none' });
    const disabled = await startAgent(settings(disabledFixture.socketPath));
    const failure = await fetch(`${disabled.baseUrl}/v1/containers/${runningId}/logs`);
    expect(failure.status).toBe(422);
    expect(await failure.json()).toMatchObject({ code: 'LOGGING_DISABLED' });
    expect(disabledFixture.calls.some((call) => call.includes('/logs?'))).toBe(false);
    const unsupportedFixture = await dockerFixture({ badLogs: true });
    const unsupported = await startAgent(settings(unsupportedFixture.socketPath));
    const noReader = await fetch(`${unsupported.baseUrl}/v1/containers/${runningId}/logs`);
    expect(noReader.status).toBe(422);
    expect(await noReader.json()).toMatchObject({ code: 'LOGS_UNAVAILABLE' });
  });
  it('rejects unbounded log requests and closes at the configured byte limit', async () => {
    const fixture = await dockerFixture({
      logs: mux(1, 'a'.repeat(64) + '\n' + 'b'.repeat(64) + '\n' + 'c'.repeat(64) + '\n'),
    });
    const agent = await startAgent({ ...settings(fixture.socketPath), maxLogBytes: 150 });
    expect((await fetch(`${agent.baseUrl}/v1/containers/${runningId}/logs?tail=all`)).status).toBe(
      400,
    );
    expect(
      (await fetch(`${agent.baseUrl}/v1/containers/${runningId}/logs?tail=999999`)).status,
    ).toBe(400);
    const result = (await (await fetch(`${agent.baseUrl}/v1/containers/${runningId}/logs`)).text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ stream: 'console', truncated: true });
  });
  it('limits concurrent follows and releases the Docker stream and slot after the browser disconnects', async () => {
    const fixture = await dockerFixture({ followOpen: true });
    const agent = await startAgent({ ...settings(fixture.socketPath), maxStreams: 1 });
    const url = `${agent.baseUrl}/v1/containers/${runningId}/logs?follow=true`;
    const first = await fetch(url),
      reader = first.body!.getReader();
    expect((await reader.read()).value?.length).toBeGreaterThan(0);
    expect((await fetch(url)).status).toBe(429);
    await reader.cancel();
    await expect.poll(() => fixture.closedStreams, { timeout: 2000 }).toBe(1);
    const resumed = await fetch(url),
      resumedReader = resumed.body!.getReader();
    expect(resumed.status).toBe(200);
    await resumedReader.read();
    await resumedReader.cancel();
    await expect.poll(() => fixture.closedStreams, { timeout: 2000 }).toBe(2);
  });
  it('bounds the lifetime of idle follows and emits a useful reconnect notice', async () => {
    const fixture = await dockerFixture({ followOpen: true });
    const agent = await startAgent({ ...settings(fixture.socketPath), streamSeconds: 1 });
    const response = await fetch(`${agent.baseUrl}/v1/containers/${runningId}/logs?follow=true`);
    const result = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(result[0]).toMatchObject({ text: 'hello' });
    expect(result.at(-1)).toMatchObject({
      stream: 'console',
      text: 'Log stream time limit reached. Resume to reconnect.',
      truncated: true,
    });
    await expect.poll(() => fixture.closedStreams, { timeout: 2000 }).toBe(1);
  });
});

describe('agent actions and authorization', () => {
  it('deduplicates concurrent mutation requests and rejects competing actions for one container', async () => {
    const fixture = await dockerFixture({ actionDelay: 50 });
    const inventory = new Inventory(fixture.docker, 'host-a'),
      actions = new Actions(fixture.docker, inventory);
    const requestId = randomUUID();
    const first = actions.run(runningId, 'restart', requestId),
      duplicate = actions.run(runningId, 'restart', requestId);
    await expect(actions.run(runningId, 'stop', randomUUID())).rejects.toMatchObject({
      code: 'ACTION_IN_PROGRESS',
    });
    await Promise.all([first, duplicate]);
    expect(fixture.mutations).toBe(1);
    await actions.run(runningId, 'restart', requestId);
    expect(fixture.mutations).toBe(1);
    await expect(actions.run(stoppedId, 'restart', requestId)).rejects.toMatchObject({
      code: 'REQUEST_ID_CONFLICT',
    });
  });
  it('requires supported action/state/full ID and does not expose a raw Docker proxy', async () => {
    const fixture = await dockerFixture();
    const agent = await startAgent(settings(fixture.socketPath));
    const post = (route: string, body: unknown) =>
      fetch(agent.baseUrl + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(
      (await post(`/v1/containers/${runningId}/start`, { requestId: randomUUID() })).status,
    ).toBe(409);
    expect(
      (await post(`/v1/containers/${runningId.slice(0, 12)}/stop`, { requestId: randomUUID() }))
        .status,
    ).toBe(404);
    expect(
      (await post(`/v1/containers/${runningId}/exec`, { requestId: randomUUID() })).status,
    ).toBe(404);
    expect(
      (
        await post(`/v1/containers/${runningId}/stop`, {
          requestId: randomUUID(),
          path: '/containers/create',
        })
      ).status,
    ).toBe(400);
    expect((await post('/v1/proxy', { method: 'POST', path: '/containers/create' })).status).toBe(
      404,
    );
    expect(fixture.mutations).toBe(0);
    const stop = await post(`/v1/containers/${runningId}/stop`, {
      requestId: randomUUID(),
      actor: 'test-user',
    });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ ok: true });
  });
  it('fails closed without TLS/host identity, and restricts explicit development mode to loopback', () => {
    expect(() => loadAgentOptions({})).toThrow('AGENT_HOST_ID');
    expect(() => loadAgentOptions({ AGENT_HOST_ID: 'host-a' })).toThrow(
      'AGENT_ALLOWED_CLIENT_NAMES',
    );
    expect(() =>
      loadAgentOptions({ AGENT_HOST_ID: 'host-a', AGENT_DEV_MODE: '1', AGENT_BIND: '0.0.0.0' }),
    ).toThrow('127.0.0.1');
    expect(() =>
      loadAgentOptions({ AGENT_HOST_ID: 'host-a', AGENT_DEV_MODE: '1', AGENT_PORT: '0' }),
    ).toThrow('AGENT_PORT');
    expect(loadAgentOptions({ AGENT_HOST_ID: 'host-a', AGENT_DEV_MODE: '1' })).toMatchObject({
      bind: '127.0.0.1',
      development: true,
    });
  });
});

describe('agent mutual TLS trust boundary', () => {
  it('allows minimal health without a cert, rejects unauthenticated/other-CN data access, and accepts the configured mTLS client', async () => {
    const openssl =
      process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-fleet-agent-pki-'));
    cleanup.push(() => {
      if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep))
        throw new Error('Unsafe test cleanup path');
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const run = (args: string[]) =>
      execFileSync(openssl, args, { cwd: directory, windowsHide: true, stdio: 'ignore' });
    run([
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
      '-days',
      '1',
      '-subj',
      '/CN=fleet-test-ca',
    ]);
    for (const [name, cn, usage] of [
      ['agent', 'localhost', 'serverAuth'],
      ['backend', 'fleet-backend', 'clientAuth'],
      ['intruder', 'other-client', 'clientAuth'],
    ] as const) {
      run([
        'req',
        '-new',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        `${name}.key`,
        '-out',
        `${name}.csr`,
        '-subj',
        `/CN=${cn}`,
      ]);
      fs.writeFileSync(
        path.join(directory, `${name}.ext`),
        `extendedKeyUsage=${usage}\n${name === 'agent' ? 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' : ''}`,
      );
      run([
        'x509',
        '-req',
        '-in',
        `${name}.csr`,
        '-CA',
        'ca.crt',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        `${name}.crt`,
        '-days',
        '1',
        '-extfile',
        `${name}.ext`,
      ]);
    }
    const read = (name: string) => fs.readFileSync(path.join(directory, name));
    const fixture = await dockerFixture();
    const agent = await startAgent({
      ...settings(fixture.socketPath),
      development: false,
      tls: {
        ca: read('ca.crt'),
        cert: read('agent.crt'),
        key: read('agent.key'),
        allowedClientNames: ['fleet-backend'],
      },
    });
    const request = (route: string, identity?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const call = https.get(
          agent.baseUrl + route,
          {
            ca: read('ca.crt'),
            ...(identity ? { cert: read(`${identity}.crt`), key: read(`${identity}.key`) } : {}),
            agent: false,
          },
          (response) => {
            let body = '';
            response.on('data', (chunk) => {
              body += String(chunk);
            });
            response.on('end', () => resolve({ status: response.statusCode!, body }));
          },
        );
        call.on('error', reject);
      });
    expect(await request('/healthz')).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect((await request('/v1/health')).status).toBe(403);
    expect((await request('/v1/snapshot', 'intruder')).status).toBe(403);
    const authorized = await request('/v1/health', 'backend');
    expect(authorized.status).toBe(200);
    expect(JSON.parse(authorized.body)).toEqual({ hostId: 'host-a', version: 1 });
    expect(fixture.calls).toHaveLength(0);
  }, 15_000);
});
