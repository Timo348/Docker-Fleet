import { afterEach, describe, expect, it } from 'vitest';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import { readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server/app.js';
import { HttpsAgentTransport } from '../src/server/agent-client.js';
import { containerId, FakeTransport, fixture } from './server-fixtures.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
async function pki() {
  const files = await fixture();
  cleanup.push(files.cleanup);
  const openssl =
    process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
  const run = (args: string[]) =>
    execFileSync(openssl, args, { cwd: files.directory, windowsHide: true, stdio: 'ignore' });
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
    '/CN=fleet-backend-test-ca',
  ]);
  for (const [name, commonName, usage] of [
    ['server', 'localhost', 'serverAuth'],
    ['proxy', 'caddy-fleet', 'clientAuth'],
    ['other', 'other-proxy', 'clientAuth'],
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
      `/CN=${commonName}`,
    ]);
    writeFileSync(
      join(files.directory, `${name}.ext`),
      `extendedKeyUsage=${usage}\n${name === 'server' ? 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' : ''}`,
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
  const read = (name: string) => readFileSync(join(files.directory, name));
  return {
    ...files,
    read,
    credential: {
      caFile: join(files.directory, 'ca.crt'),
      certFile: join(files.directory, 'proxy.crt'),
      keyFile: join(files.directory, 'proxy.key'),
      serverName: 'localhost',
    },
  };
}
async function request(
  baseUrl: string,
  read: (file: string) => Buffer,
  route: string,
  identity?: string,
  headers: Record<string, string> = {},
  method = 'GET',
) {
  return new Promise<{ status: number; body: string; json: () => Record<string, unknown> }>(
    (resolve, reject) => {
      const req = https.request(
        baseUrl + route,
        {
          method,
          ca: read('ca.crt'),
          ...(identity ? { cert: read(`${identity}.crt`), key: read(`${identity}.key`) } : {}),
          headers,
          agent: false,
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += String(chunk);
          });
          response.on('end', () =>
            resolve({ status: response.statusCode!, body, json: () => JSON.parse(body) }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

describe('production backend HTTPS authentication', () => {
  it('requires a trusted mTLS proxy identity and confirmed allowed user for data and mutations', async () => {
    const files = await pki();
    const config = {
      ...files.config,
      baseUrl: 'https://fleet.example.org',
      auth: { ...files.config.auth, mode: 'proxy' as const },
      server: {
        ...files.config.server,
        tls: {
          certFile: join(files.directory, 'server.crt'),
          keyFile: join(files.directory, 'server.key'),
          proxyCaFile: join(files.directory, 'ca.crt'),
          allowedProxyNames: ['caddy-fleet'],
        },
      },
    };
    await writeFile(files.configFile, JSON.stringify(config));
    const server = await createServer({
      configFile: files.configFile,
      transport: new FakeTransport(),
      startPolling: false,
      serveStatic: false,
    });
    cleanup.push(() => server.app.close());
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = server.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener.');
    const baseUrl = `https://127.0.0.1:${address.port}`;
    const headers = { 'x-authentik-username': 'test-user', 'x-authentik-uid': 'confirmed-subject' };
    expect(await request(baseUrl, files.read, '/healthz')).toMatchObject({
      status: 200,
      body: '{"ok":true}',
    });
    expect((await request(baseUrl, files.read, '/api/session', undefined, headers)).status).toBe(
      401,
    );
    expect((await request(baseUrl, files.read, '/api/session', 'other', headers)).status).toBe(401);
    expect(
      (
        await request(baseUrl, files.read, '/api/session', 'proxy', {
          ...headers,
          'x-authentik-username': 'other-user',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(baseUrl, files.read, '/api/session', 'proxy', {
          'x-authentik-username': 'test-user',
        })
      ).status,
    ).toBe(401);
    const authorized = await request(baseUrl, files.read, '/api/session', 'proxy', headers);
    expect(authorized.status).toBe(200);
    expect(authorized.json()).toMatchObject({ user: 'test-user', development: false });
    const csrf = String(authorized.json().csrfToken);
    expect(
      (
        await request(
          baseUrl,
          files.read,
          '/api/refresh',
          'proxy',
          { ...headers, origin: config.baseUrl },
          'POST',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          baseUrl,
          files.read,
          '/api/refresh',
          'proxy',
          { ...headers, origin: 'https://sibling.example.org', 'x-csrf-token': csrf },
          'POST',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          baseUrl,
          files.read,
          '/api/refresh',
          'proxy',
          { ...headers, origin: config.baseUrl, 'x-csrf-token': csrf },
          'POST',
        )
      ).status,
    ).toBe(200);
  }, 15000);
});

describe('agent HTTPS request deadlines and safe errors', () => {
  async function start(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
    bind = '127.0.0.1',
  ) {
    const files = await pki();
    const server = https.createServer(
      {
        cert: files.read('server.crt'),
        key: files.read('server.key'),
        ca: files.read('ca.crt'),
        requestCert: true,
        rejectUnauthorized: true,
      },
      handler,
    );
    server.listen(0, bind);
    await once(server, 'listening');
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener.');
    const host = {
      ...files.config.hosts[0],
      agentUrl: `https://${bind.includes(':') ? `[${bind}]` : bind}:${address.port}`,
      timeoutMs: 200,
    };
    const transport = new HttpsAgentTransport({ first: files.credential });
    cleanup.push(async () => transport.close());
    return { files, host, transport };
  }
  it('enforces a complete response deadline against a continuously trickling body', async () => {
    const { host, transport } = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      const timer = setInterval(() => response.write(' '), 30);
      response.once('close', () => clearInterval(timer));
    });
    const began = Date.now();
    await expect(transport.snapshot(host)).rejects.toMatchObject({ code: 'AGENT_UNAVAILABLE' });
    expect(Date.now() - began).toBeLessThan(1500);
  }, 15000);
  it('returns known logging errors without echoing agent secrets and records unconfirmed state as uncertain', async () => {
    const { host, transport } = await start((request, response) => {
      const logs = request.url?.includes('/logs');
      response.writeHead(logs ? 422 : 409, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          code: logs ? 'LOGS_UNAVAILABLE' : 'STATE_NOT_CONFIRMED',
          message: 'PASSWORD=DO_NOT_EXPOSE',
        }),
      );
    });
    const logging = await transport
      .logs(host, containerId, 10, false, new AbortController().signal)
      .catch((error) => error);
    expect(logging).toMatchObject({ code: 'LOGS_UNAVAILABLE', statusCode: 422 });
    expect(logging.message).toContain('logging driver');
    expect(logging.message).not.toContain('PASSWORD');
    await expect(
      transport.action(
        host,
        containerId,
        'restart',
        '00000000-0000-4000-8000-000000000001',
        'test-user',
      ),
    ).rejects.toMatchObject({ code: 'STATE_NOT_CONFIRMED', uncertain: true });
  }, 15000);
  it('uses a mutation budget that exceeds a short host connection deadline', async () => {
    const { host, transport } = await start((request, response) => {
      expect(request.socket).toBeInstanceOf(TLSSocket);
      expect((request.socket as TLSSocket).authorized).toBe(true);
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
      }, 350);
    });
    await expect(
      transport.action(
        host,
        containerId,
        'stop',
        '00000000-0000-4000-8000-000000000001',
        'test-user',
      ),
    ).resolves.toBeUndefined();
  }, 15000);
  it('checks the configured server identity instead of accepting any certificate from the CA', async () => {
    const { files, host } = await start((_request, response) => {
      response.end('{"hostId":"srv-1","version":1}');
    });
    const transport = new HttpsAgentTransport({
      first: { ...files.credential, serverName: 'wrong-host.example.org' },
    });
    cleanup.push(async () => transport.close());
    await expect(transport.health(host)).rejects.toThrow(/certificate verification failed/);
  }, 15000);
  it('connects IPv6 URL addresses using an unbracketed socket hostname', async () => {
    const { transport, host } = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"hostId":"srv-1","version":1}');
    }, '::1');
    await expect(transport.health(host)).resolves.toEqual({ hostId: 'srv-1', version: 1 });
  }, 15000);
});
