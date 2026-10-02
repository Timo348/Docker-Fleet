import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { Server as HttpServer } from 'node:http';
import fastifyStatic from '@fastify/static';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Action } from '../shared/types.js';
import { AgentError, ApiError } from './errors.js';
import { ConfigStore } from './config.js';
import { Authenticator, type Identity } from './auth.js';
import { HttpsAgentTransport, type AgentTransport } from './agent-client.js';
import { Fleet } from './fleet.js';
import { AuditLog } from './audit.js';
import { LogStreams } from './logs.js';

interface Operation {
  target: string;
  promise: Promise<{ ok: true }>;
  expires: number;
}
export interface ServerOptions {
  configFile?: string;
  transport?: AgentTransport;
  startPolling?: boolean;
  serveStatic?: boolean;
  allowDev?: boolean;
}
export async function createServer(options: ServerOptions = {}) {
  const store = await ConfigStore.load(
    options.configFile || process.env.CONFIG_FILE || '/config/config.yml',
    options.allowDev ?? process.env.ALLOW_DEV_MODE === '1',
  );
  const config = store.current;
  const secret = await readFile(config.auth.csrfSecretFile);
  const authenticator = new Authenticator(config, secret);
  const tls = config.auth.mode === 'proxy' ? config.server.tls! : undefined;
  const app = Fastify<HttpServer>({
    logger: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30000,
    connectionTimeout: 15000,
    routerOptions: { maxParamLength: 128 },
    ...(tls
      ? {
          https: {
            cert: await readFile(tls.certFile),
            key: await readFile(tls.keyFile),
            ca: await readFile(tls.proxyCaFile),
            requestCert: true,
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2' as const,
          },
        }
      : {}),
  });
  const transport = options.transport || new HttpsAgentTransport(config.credentials);
  const fleet = new Fleet(config, transport);
  const audit = new AuditLog(config.storage.dataDir, config.storage.auditMaxBytes);
  await audit.initialize();
  const logs = new LogStreams(config, transport);
  const identities = new WeakMap<FastifyRequest, Identity>();
  const operations = new Map<string, Operation>();
  const busy = new Set<string>();
  const stopConfigListener = store.subscribe((next) => {
    fleet.configure(next);
    logs.configure(next);
  });
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-store')
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
    if (request.url.split('?')[0] === '/healthz' && request.method === 'GET') return;
    const identity = authenticator.identity(request);
    identities.set(request, identity);
    authenticator.verifyReadOrigin(request);
    if (!['GET', 'HEAD'].includes(request.method)) authenticator.verifyMutation(request, identity);
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError)
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    const status =
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : 500;
    return reply.code(status).send({
      code: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
      message:
        status === 500
          ? 'The request failed. Check the protected server logs or file permissions.'
          : 'The request body or parameters are invalid.',
    });
  });
  const identity = (request: FastifyRequest) => identities.get(request)!;
  function params(request: FastifyRequest): { hostId: string; id: string; action: Action } {
    const value = request.params as { hostId?: string; id?: string; action?: string };
    if (!value.hostId || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.hostId))
      throw new ApiError(400, 'INVALID_HOST_ID', 'Select a valid configured host.');
    if (value.id !== undefined && !/^[a-f0-9]{64}$/.test(value.id))
      throw new ApiError(
        400,
        'INVALID_CONTAINER_ID',
        'A complete Docker container ID is required.',
      );
    if (value.action !== undefined && !['start', 'stop', 'restart'].includes(value.action))
      throw new ApiError(403, 'ACTION_FORBIDDEN', 'Only start, stop and restart are supported.');
    return value as { hostId: string; id: string; action: Action };
  }
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/api/session', async (request) => {
    const user = identity(request);
    return {
      user: user.username,
      csrfToken: authenticator.token(user),
      development: user.development,
    };
  });
  app.get('/api/resources', async () => fleet.resources());
  app.post('/api/refresh', async () => {
    await fleet.refreshAll();
    return fleet.resources();
  });
  app.get('/api/config', async (_request, reply) => {
    // A manual edit becomes reviewable immediately; invalid edits leave the last valid runtime config untouched.
    await store.reload();
    const publicConfig = store.publicConfig();
    reply.header('etag', publicConfig.revision);
    return publicConfig;
  });
  app.put('/api/config', async (request, reply) => {
    const match = request.headers['if-match'];
    const result = await store.update(request.body, typeof match === 'string' ? match : undefined);
    reply.header('etag', result.revision);
    return result;
  });
  app.post('/api/hosts/:hostId/test', async (request) => {
    const { hostId } = params(request);
    return fleet.testHost(hostId);
  });
  app.post('/api/hosts/:hostId/containers/:id/:action', async (request) => {
    const { hostId, id, action } = params(request);
    const host = fleet.host(hostId);
    const user = identity(request);
    const body = request.body as { requestId?: unknown } | undefined;
    if (
      !body ||
      typeof body !== 'object' ||
      Object.keys(body).some((key) => key !== 'requestId') ||
      typeof body.requestId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.requestId)
    )
      throw new ApiError(400, 'INVALID_REQUEST_ID', 'Provide a unique requestId UUID.');
    const requestId = body.requestId;
    const opKey = `${user.subject}\0${requestId}`;
    const target = `${hostId}/${id}/${action}`;
    const resourceKey = `${hostId}/${id}`;
    const prior = operations.get(opKey);
    if (prior) {
      if (prior.target !== target)
        throw new ApiError(
          409,
          'REQUEST_ID_CONFLICT',
          'This requestId was already used for another action.',
        );
      return prior.promise;
    }
    if (busy.has(resourceKey))
      throw new ApiError(
        409,
        'ACTION_IN_PROGRESS',
        'Another action is already running for this container.',
      );
    for (const [key, operation] of operations)
      if (operation.expires < Date.now()) operations.delete(key);
    if (operations.size >= 10000)
      throw new ApiError(429, 'ACTION_LIMIT', 'The action ledger is full. Try again later.');
    busy.add(resourceKey);
    const auditFields = { user: user.username, host: hostId, containerId: id, action, requestId };
    const promise = (async (): Promise<{ ok: true }> => {
      try {
        try {
          await audit.record({ ...auditFields, result: 'pending' });
        } catch {
          throw new ApiError(
            503,
            'AUDIT_UNAVAILABLE',
            'The action was not executed because audit storage is unavailable. Check storage permissions and available space.',
          );
        }
        try {
          const health = await transport.health(host);
          if (health.hostId !== host.id || health.version !== 1)
            throw new ApiError(
              502,
              'AGENT_IDENTITY_MISMATCH',
              'The agent identity does not match the selected host.',
            );
          await transport.action(host, id, action, requestId, user.username);
        } catch (error) {
          await audit
            .record({
              ...auditFields,
              result: error instanceof AgentError && error.uncertain ? 'unknown' : 'failure',
            })
            .catch(() => undefined);
          throw error;
        }
        try {
          await audit.record({ ...auditFields, result: 'success' });
        } catch {
          throw new ApiError(
            503,
            'AUDIT_RESULT_UNKNOWN',
            'The action ran, but its audit result could not be persisted. Refresh the actual container state before another action.',
          );
        }
        await fleet.refreshHost(hostId);
        return { ok: true };
      } finally {
        busy.delete(resourceKey);
      }
    })();
    operations.set(opKey, { target, promise, expires: Date.now() + 86400000 });
    return promise;
  });
  app.get('/api/hosts/:hostId/containers/:id/logs', async (request, reply) => {
    const { hostId, id } = params(request);
    const host = fleet.host(hostId);
    const policy = store.current.logs;
    const query = request.query as { tail?: string; follow?: string };
    if (
      Object.keys(query).some((key) => !['tail', 'follow'].includes(key)) ||
      (query.tail !== undefined && !/^\d{1,5}$/.test(query.tail)) ||
      (query.follow !== undefined && !['true', 'false'].includes(query.follow))
    )
      throw new ApiError(
        400,
        'INVALID_LOG_REQUEST',
        'Use an integer tail and follow=true or follow=false.',
      );
    const tail = query.tail === undefined ? policy.defaultTail : Number(query.tail);
    if (tail < 1 || tail > policy.maxTail)
      throw new ApiError(400, 'INVALID_LOG_TAIL', `tail must be between 1 and ${policy.maxTail}.`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    reply.raw.once('close', abort);
    try {
      const health = await transport.health(host);
      if (health.hostId !== host.id || health.version !== 1)
        throw new ApiError(
          502,
          'AGENT_IDENTITY_MISMATCH',
          'The agent identity does not match the selected host.',
        );
      const stream = await logs.open(
        host,
        id,
        identity(request).subject,
        tail,
        query.follow === 'true',
        controller.signal,
      );
      reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('x-accel-buffering', 'no');
      return reply.send(stream);
    } catch (error) {
      reply.raw.removeListener('close', abort);
      controller.abort();
      throw error;
    }
  });
  if (options.serveStatic !== false) {
    const webRoot = resolve(process.env.WEB_ROOT || 'dist-web');
    if (existsSync(webRoot)) {
      await app.register(fastifyStatic, { root: webRoot, wildcard: false });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method))
          return reply.code(404).send({ code: 'NOT_FOUND', message: 'This route does not exist.' });
        return reply.sendFile('index.html');
      });
    }
  }
  // Stop live streams before Fastify waits for active responses during shutdown.
  app.addHook('preClose', async () => {
    logs.close();
    fleet.close();
  });
  app.addHook('onClose', async () => {
    stopConfigListener();
    transport.close?.();
    await audit.close();
  });
  if (options.startPolling !== false) fleet.start();
  return {
    app,
    store,
    fleet,
    logs,
    audit,
    async listen() {
      return app.listen({ host: config.server.host, port: config.server.port });
    },
  };
}
