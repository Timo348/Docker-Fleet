import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from '../src/server/app.js';
import { AgentError } from '../src/server/errors.js';
import { parseSnapshot } from '../src/server/agent-client.js';
import { cleanLogText } from '../src/server/logs.js';
import { validateComposeYaml } from '../src/shared/compose.js';
import { containerId, FakeTransport, fixture, snapshot } from './server-fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const files = await fixture();
  cleanups.push(files.cleanup);
  const transport = new FakeTransport();
  const server = await createServer({
    configFile: files.configFile,
    transport,
    allowDev: true,
    startPolling: false,
    serveStatic: false,
  });
  cleanups.push(() => server.app.close());
  const session = (await server.app.inject('/api/session')).json<{ csrfToken: string }>();
  const headers = { origin: files.config.baseUrl, 'x-csrf-token': session.csrfToken };
  return { ...files, ...server, transport, headers };
}

describe('central backend security and host isolation', () => {
  it('requires exact origin and CSRF token for all mutations, including connection tests', async () => {
    const { app, headers } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/refresh' })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/refresh',
          headers: { ...headers, origin: 'http://sibling.example.org' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/hosts/srv-1/test',
          headers: { origin: headers.origin },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/refresh', headers })).statusCode).toBe(
      200,
    );
    const foreign = await app.inject({
      url: '/api/resources',
      headers: { origin: 'http://foreign.example.org' },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('keeps identical resources separated by host and does not drop available data when another host fails', async () => {
    const { fleet, transport } = await setup();
    await fleet.refreshAll();
    let data = fleet.resources();
    expect(data.containers.map((container) => [container.hostId, container.id])).toEqual([
      ['srv-1', containerId],
      ['srv-2', containerId],
    ]);
    expect(data.containers[0].health).toBeNull();
    expect(data.volumes[0].sizeBytes).toBeNull();
    expect(data.containers[0].cpuPercent).toBe(25);
    transport.failHosts.add('srv-2');
    await fleet.refreshAll();
    data = fleet.resources();
    expect(data.hosts.find((host) => host.id === 'srv-1')?.state).toBe('online');
    expect(data.hosts.find((host) => host.id === 'srv-2')).toMatchObject({
      state: 'offline',
      stale: true,
    });
    expect(data.containers).toHaveLength(2);
    expect(data.hosts[1].lastSuccess).not.toBeNull();
  });
  it('rejects an agent reporting a different host ID and suppresses disabled host resources', async () => {
    const { fleet, transport, store, config } = await setup();
    transport.healthIds.set('srv-2', 'srv-1');
    await fleet.refreshAll();
    expect(fleet.resources().containers).toHaveLength(1);
    expect(fleet.resources().hosts[1].error).toContain('identity');
    await store.update(
      {
        hosts: config.hosts.map((host) => ({ ...host, enabled: host.id === 'srv-2' })),
        polling: config.polling,
        logs: config.logs,
      },
      store.publicConfig().revision,
    );
    expect(fleet.resources().hosts[0].state).toBe('disabled');
    expect(fleet.resources().containers).toHaveLength(0);
  });
  it('verifies the selected host identity again before an action or log stream', async () => {
    const { app, transport, headers } = await setup();
    transport.healthIds.set('srv-2', 'srv-1');
    const action = await app.inject({
      method: 'POST',
      url: `/api/hosts/srv-2/containers/${containerId}/stop`,
      headers,
      payload: { requestId: '00000000-0000-4000-8000-000000000005' },
    });
    const logs = await app.inject(`/api/hosts/srv-2/containers/${containerId}/logs`);
    expect(action.statusCode).toBe(502);
    expect(action.json().code).toBe('AGENT_IDENTITY_MISMATCH');
    expect(logs.statusCode).toBe(502);
    expect(transport.actionCalls).toHaveLength(0);
  });
  it('does not let fresh statistics make an expired inventory look fresh', async () => {
    const { fleet } = await setup();
    await fleet.refreshAll();
    const lastSuccess = fleet.resources().hosts[0].lastSuccess;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 60000);
    try {
      expect(fleet.resources().hosts[0]).toMatchObject({ stale: true, lastSuccess });
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('routes actions to the selected host, deduplicates repeats and updates actual resources with an audit record', async () => {
    const { app, transport, headers, directory } = await setup();
    const request = {
      method: 'POST' as const,
      url: `/api/hosts/srv-2/containers/${containerId}/restart`,
      headers,
      payload: { requestId: '00000000-0000-4000-8000-000000000001' },
    };
    const results = await Promise.all([app.inject(request), app.inject(request)]);
    expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
    expect(transport.actionCalls).toHaveLength(1);
    expect(transport.actionCalls[0]).toMatchObject({
      host: 'srv-2',
      id: containerId,
      action: 'restart',
      actor: 'test-user',
    });
    expect(transport.snapshotCalls).toContain('srv-2');
    const audit = (await readFile(join(directory, 'data', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(audit.map((record) => record.result)).toEqual(['pending', 'success']);
    expect(Object.keys(audit[0]).sort()).toEqual([
      'action',
      'containerId',
      'host',
      'requestId',
      'result',
      'time',
      'user',
    ]);
    const conflict = await app.inject({
      ...request,
      url: `/api/hosts/srv-1/containers/${containerId}/stop`,
    });
    expect(conflict.statusCode).toBe(409);
  });
  it('rejects arbitrary actions and IDs and prevents concurrent commands to the same container', async () => {
    const { app, transport, headers } = await setup();
    for (const [id, action, code] of [
      [containerId, 'exec', 403],
      ['short', 'stop', 400],
    ] as const)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/hosts/srv-1/containers/${id}/${action}`,
            headers,
            payload: { requestId: '00000000-0000-4000-8000-000000000001' },
          })
        ).statusCode,
      ).toBe(code);
    let finish!: () => void;
    transport.actionWait = new Promise((resolve) => {
      finish = resolve;
    });
    const first = app.inject({
      method: 'POST',
      url: `/api/hosts/srv-1/containers/${containerId}/stop`,
      headers,
      payload: { requestId: '00000000-0000-4000-8000-000000000002' },
    });
    while (!transport.actionCalls.length) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await app.inject({
      method: 'POST',
      url: `/api/hosts/srv-1/containers/${containerId}/restart`,
      headers,
      payload: { requestId: '00000000-0000-4000-8000-000000000003' },
    });
    finish();
    await first;
    expect(second.statusCode).toBe(409);
    expect(transport.actionCalls).toHaveLength(1);
  });
  it('records an uncertain action without retrying or claiming success', async () => {
    const { app, transport, headers, directory } = await setup();
    transport.actionFailure = new AgentError('Result unknown.', 'ACTION_RESULT_UNKNOWN', true);
    const request = {
      method: 'POST' as const,
      url: `/api/hosts/srv-1/containers/${containerId}/restart`,
      headers,
      payload: { requestId: '00000000-0000-4000-8000-000000000001' },
    };
    expect((await app.inject(request)).statusCode).toBe(502);
    expect((await app.inject(request)).statusCode).toBe(502);
    expect(transport.actionCalls).toHaveLength(1);
    const events = (await readFile(join(directory, 'data', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.result)).toEqual(['pending', 'unknown']);
  });
  it('fails closed when the audit cannot be persisted before a mutation', async () => {
    const { app, audit, transport, headers } = await setup();
    vi.spyOn(audit, 'record').mockRejectedValue(new Error('disk full'));
    const result = await app.inject({
      method: 'POST',
      url: `/api/hosts/srv-1/containers/${containerId}/stop`,
      headers,
      payload: { requestId: '00000000-0000-4000-8000-000000000006' },
    });
    expect(result.statusCode).toBe(503);
    expect(result.json().code).toBe('AUDIT_UNAVAILABLE');
    expect(transport.actionCalls).toHaveLength(0);
    vi.restoreAllMocks();
  });
  it('limits log queries, preserves plain text and strips terminal controls', async () => {
    const { app, headers, logs } = await setup();
    const response = await app.inject(
      `/api/hosts/srv-1/containers/${containerId}/logs?tail=20&follow=false`,
    );
    expect(response.statusCode).toBe(200);
    const line = JSON.parse(response.body.trim());
    expect(line.text).toContain('<script>alert(1)</script>');
    expect(line.text).not.toContain('\u001b');
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(logs.count).toBe(0);
    expect(
      (await app.inject(`/api/hosts/srv-1/containers/${containerId}/logs?tail=9999`)).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `/api/hosts/srv-1/containers/${containerId}/logs`,
          headers: { origin: 'http://other.example.org' },
        })
      ).statusCode,
    ).toBe(403);
    expect(cleanLogText('\u001b]0;secret-title\u0007hello\u0000')).toBe('hello');
  });
  it('bounds streams and cancels them when a host is disabled', async () => {
    const { transport, logs, config, store } = await setup();
    transport.streamFactory = () => new Readable({ read() {} });
    const a = await logs.open(
      config.hosts[0],
      containerId,
      'user',
      10,
      true,
      new AbortController().signal,
    );
    const b = await logs.open(
      config.hosts[0],
      containerId,
      'user',
      10,
      true,
      new AbortController().signal,
    );
    await expect(
      logs.open(config.hosts[1], containerId, 'user', 10, true, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'LOG_STREAM_LIMIT' });
    // Start consuming so generator-finally is exercised when the underlying stream is aborted.
    a.resume();
    b.resume();
    await store.update(
      {
        hosts: config.hosts.map((host) => ({ ...host, enabled: false })),
        polling: config.polling,
        logs: config.logs,
      },
      store.publicConfig().revision,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(logs.count).toBe(0);
    a.destroy();
    b.destroy();
  });
  it('cancels active log responses before waiting for server shutdown', async () => {
    const { app, transport, logs } = await setup();
    transport.streamFactory = () => new Readable({ read() {} });
    const pending = app.inject(`/api/hosts/srv-1/containers/${containerId}/logs?follow=true`);
    await expect.poll(() => logs.count, { timeout: 1000 }).toBe(1);
    const began = Date.now();
    await app.close();
    await pending;
    expect(Date.now() - began).toBeLessThan(1000);
    expect(logs.count).toBe(0);
  });
  it('projects agent payloads and clears statistics on stopped containers', () => {
    const raw = snapshot();
    (raw.containers[0] as unknown as Record<string, unknown>).Env = ['PASSWORD=secret'];
    raw.containers[0].state = 'exited';
    raw.containers[0].cpuPercent = 50;
    raw.containers[0].memoryBytes = 123;
    const result = parseSnapshot(raw);
    expect(JSON.stringify(result)).not.toContain('PASSWORD');
    expect(result.containers[0].cpuPercent).toBeNull();
    expect(result.containers[0].memoryBytes).toBeNull();
  });
});

describe('central backend Compose API, YAML validation, stack isolation and audit logging', () => {
  it('validates Compose YAML syntax, structure and sanitization rules', () => {
    const valid = validateComposeYaml(
      'name: demo\nservices:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n',
    );
    expect(valid.valid).toBe(true);
    expect(valid.services).toEqual(['web']);

    expect(validateComposeYaml('').valid).toBe(false);
    expect(validateComposeYaml('services:\n  web:\n    image: "a\0b"\n').valid).toBe(false);
    expect(validateComposeYaml('services:\n  web:\n    image: [unclosed\n').message).toContain(
      'Invalid YAML',
    );
    expect(validateComposeYaml('version: "3"\n').message).toContain('"services"');
    expect(validateComposeYaml('services: {}\n').message).toContain('at least one service');
    expect(
      validateComposeYaml('services:\n  web:\n    image: alpine:3\n    ports: "80:80"\n').message,
    ).toContain('"ports" must be a list');
  });

  it('retrieves Compose files, enforces CSRF/Origin on updates, and returns YAML validation errors before calling the agent', async () => {
    const { app, fleet, transport, headers } = await setup();
    await fleet.refreshAll();

    // Retrieve compose file
    const getRes = await app.inject(`/api/hosts/srv-1/containers/${containerId}/compose`);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.headers.etag).toBe('"rev-initial"');
    expect(getRes.json()).toMatchObject({
      project: 'demo',
      service: 'web',
      fileName: 'docker-compose.yml',
    });

    // Reject missing CSRF on PUT
    const noCsrf = await app.inject({
      method: 'PUT',
      url: `/api/hosts/srv-1/containers/${containerId}/compose`,
      headers: { origin: headers.origin },
      payload: {
        requestId: '00000000-0000-4000-8000-000000000010',
        content: 'services:\n  web:\n    image: alpine:3.20\n',
        redeploy: false,
      },
    });
    expect(noCsrf.statusCode).toBe(403);

    // Reject invalid YAML before contacting the agent
    const invalidYaml = await app.inject({
      method: 'PUT',
      url: `/api/hosts/srv-1/containers/${containerId}/compose`,
      headers,
      payload: {
        requestId: '00000000-0000-4000-8000-000000000011',
        content: 'services:\n  web:\n    image: [broken\n',
        redeploy: false,
      },
    });
    expect(invalidYaml.statusCode).toBe(400);
    expect(invalidYaml.json().code).toBe('INVALID_COMPOSE_YAML');
    expect(invalidYaml.json().message).toContain('Invalid YAML');
    expect(transport.composeSaveCalls).toHaveLength(0);

    // Reject removing the stack's own service
    const missingService = await app.inject({
      method: 'PUT',
      url: `/api/hosts/srv-1/containers/${containerId}/compose`,
      headers,
      payload: {
        requestId: '00000000-0000-4000-8000-000000000012',
        content: 'services:\n  other:\n    image: alpine:3\n',
        redeploy: false,
      },
    });
    expect(missingService.statusCode).toBe(400);
    expect(missingService.json().code).toBe('INVALID_COMPOSE_YAML');
    expect(transport.composeSaveCalls).toHaveLength(0);
  });

  it('supports Save only and Save + Redeploy, logs modifications to audit.jsonl and verifies agent identity', async () => {
    const { app, fleet, transport, headers, directory } = await setup();
    await fleet.refreshAll();

    // Save only
    const saveOnly = await app.inject({
      method: 'PUT',
      url: `/api/hosts/srv-1/containers/${containerId}/compose`,
      headers,
      payload: {
        requestId: '00000000-0000-4000-8000-000000000021',
        content: 'services:\n  web:\n    image: alpine:3.20\n',
        redeploy: false,
        expectedRevision: '"rev-initial"',
      },
    });
    expect(saveOnly.statusCode).toBe(200);
    expect(saveOnly.json()).toMatchObject({
      ok: true,
      project: 'demo',
      fileName: 'docker-compose.yml',
      redeployed: false,
    });

    // Save + Redeploy
    const saveRedeploy = await app.inject({
      method: 'POST',
      url: `/api/hosts/srv-1/containers/${containerId}/compose`,
      headers,
      payload: {
        requestId: '00000000-0000-4000-8000-000000000022',
        content: 'services:\n  web:\n    image: alpine:3.21\n',
        redeploy: true,
        expectedRevision: '"rev-1"',
      },
    });
    expect(saveRedeploy.statusCode).toBe(200);
    expect(saveRedeploy.json()).toMatchObject({
      ok: true,
      project: 'demo',
      fileName: 'docker-compose.yml',
      redeployed: true,
    });

    expect(transport.composeSaveCalls).toHaveLength(2);
    expect(transport.composeSaveCalls[0]?.redeploy).toBe(false);
    expect(transport.composeSaveCalls[1]?.redeploy).toBe(true);

    // Check audit records
    const auditRecords = (await readFile(join(directory, 'data', 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(auditRecords.map((r) => [r.action, r.result])).toEqual([
      ['compose-save', 'pending'],
      ['compose-save', 'success'],
      ['compose-redeploy', 'pending'],
      ['compose-redeploy', 'success'],
    ]);

    // Verify agent identity mismatch protection
    transport.healthIds.set('srv-2', 'srv-1');
    const mismatchGet = await app.inject(`/api/hosts/srv-2/containers/${containerId}/compose`);
    expect(mismatchGet.statusCode).toBe(502);
    expect(mismatchGet.json().code).toBe('AGENT_IDENTITY_MISMATCH');

    // Reject standalone containers that do not originate from Compose
    const nonComposeSnap = snapshot();
    nonComposeSnap.containers[0]!.composeProject = null;
    nonComposeSnap.containers[0]!.composeService = null;
    transport.snapshots.set('srv-1', nonComposeSnap);
    await fleet.refreshHost('srv-1');
    const nonComposeRes = await app.inject(`/api/hosts/srv-1/containers/${containerId}/compose`);
    expect(nonComposeRes.statusCode).toBe(404);
    expect(nonComposeRes.json().code).toBe('COMPOSE_NOT_FOUND');
  });
});
