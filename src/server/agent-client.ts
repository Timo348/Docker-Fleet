import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type {
  Action,
  AppConfig,
  Container,
  HostConfig,
  Image,
  Snapshot,
  Stats,
  Volume,
} from '../shared/types.js';
import { AgentError } from './errors.js';

export interface AgentTransport {
  health(host: HostConfig): Promise<{ hostId: string; version: number }>;
  snapshot(host: HostConfig): Promise<Snapshot>;
  stats(host: HostConfig): Promise<Stats[]>;
  action(
    host: HostConfig,
    id: string,
    action: Action,
    requestId: string,
    actor: string,
  ): Promise<void>;
  logs(
    host: HostConfig,
    id: string,
    tail: number,
    follow: boolean,
    signal: AbortSignal,
  ): Promise<Readable>;
  close?(): void;
}

const maxBody = 16 * 1024 * 1024;
const fullId = /^[a-f0-9]{64}$/;
function badResponse(): never {
  throw new AgentError('The agent returned invalid resource data.', 'INVALID_AGENT_RESPONSE');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) badResponse();
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 1024): string {
  if (typeof value !== 'string' || value.length > max) badResponse();
  return value;
}
function nullableString(value: unknown, max = 1024): string | null {
  return value === null ? null : string(value, max);
}
function number(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  )
    badResponse();
  return value;
}
function nullableNumber(value: unknown): number | null {
  return value === null ? null : number(value);
}
function array(value: unknown, max = 5000): unknown[] {
  if (!Array.isArray(value) || value.length > max) badResponse();
  return value;
}
function id(value: unknown): string {
  const result = string(value, 64);
  if (!fullId.test(result)) badResponse();
  return result;
}
function date(value: unknown): string {
  const result = string(value, 64);
  if (!Number.isFinite(Date.parse(result))) badResponse();
  return result;
}

export function parseStats(value: unknown): Stats[] {
  const seen = new Set<string>();
  return array(value).map((item) => {
    const entry = record(item);
    const containerId = id(entry.id);
    if (seen.has(containerId)) badResponse();
    seen.add(containerId);
    return {
      id: containerId,
      cpuPercent: nullableNumber(entry.cpuPercent),
      memoryBytes: nullableNumber(entry.memoryBytes),
      memoryLimitBytes: nullableNumber(entry.memoryLimitBytes),
    };
  });
}
export function parseSnapshot(value: unknown): Snapshot {
  const entry = record(value);
  const containers: Container[] = array(entry.containers).map((item) => {
    const c = record(item);
    const state = string(c.state, 40);
    return {
      id: id(c.id),
      name: string(c.name, 255),
      image: string(c.image),
      imageId: string(c.imageId, 128),
      state,
      status: string(c.status, 1024),
      health: nullableString(c.health, 40),
      cpuPercent: state === 'running' ? nullableNumber(c.cpuPercent) : null,
      memoryBytes: state === 'running' ? nullableNumber(c.memoryBytes) : null,
      memoryLimitBytes: state === 'running' ? nullableNumber(c.memoryLimitBytes) : null,
      ports: array(c.ports, 256).map((item) => {
        const p = record(item);
        return {
          ip: string(p.ip, 64),
          privatePort: number(p.privatePort),
          ...(p.publicPort === undefined ? {} : { publicPort: number(p.publicPort) }),
          type: string(p.type, 16),
        };
      }),
      composeProject: nullableString(c.composeProject, 255),
      composeService: nullableString(c.composeService, 255),
      startedAt: c.startedAt === null ? null : date(c.startedAt),
    };
  });
  const images: Image[] = array(entry.images).map((item) => {
    const i = record(item);
    return {
      id: string(i.id, 128),
      tags: array(i.tags, 256).map((tag) => string(tag)),
      sizeBytes: number(i.sizeBytes),
      createdAt: date(i.createdAt),
      containerIds: array(i.containerIds).map(id),
    };
  });
  const volumes: Volume[] = array(entry.volumes).map((item) => {
    const v = record(item);
    return {
      id: string(v.id, 255),
      name: string(v.name, 255),
      driver: string(v.driver, 255),
      scope: string(v.scope, 64),
      containerIds: array(v.containerIds).map(id),
      composeProject: nullableString(v.composeProject, 255),
      sizeBytes: null,
    };
  });
  for (const resources of [containers, images, volumes])
    if (new Set(resources.map((item) => item.id)).size !== resources.length) badResponse();
  return {
    containers,
    images,
    volumes,
    collectedAt: date(entry.collectedAt),
    engineVersion: string(entry.engineVersion, 128),
  };
}

function connectionError(error: unknown, mutation = false): AgentError {
  if (error instanceof AgentError) {
    if (mutation && error.statusCode >= 500) error.uncertain = true;
    return error;
  }
  const code = (error as NodeJS.ErrnoException)?.code || '';
  const message =
    code === 'ENOTFOUND' || code === 'EAI_AGAIN'
      ? 'Agent DNS lookup failed.'
      : code === 'ECONNREFUSED'
        ? 'The agent refused the connection.'
        : code.includes('CERT') ||
            code.includes('TLS') ||
            code.includes('SSL') ||
            code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
          ? 'Agent TLS certificate verification failed.'
          : code === 'ETIMEDOUT'
            ? 'The agent connection timed out.'
            : code === 'ABORT_ERR'
              ? 'The agent request was cancelled.'
              : 'The agent connection failed.';
  return new AgentError(
    mutation ? `${message} The action result may be unknown; refresh before retrying.` : message,
    'AGENT_UNAVAILABLE',
    mutation,
  );
}

const knownFailures: Record<string, { message: string; status: number; uncertain?: boolean }> = {
  STATE_CONFLICT: {
    message: 'The container state does not allow this action. Refresh the container list.',
    status: 409,
  },
  STATE_NOT_CONFIRMED: {
    message:
      'Docker accepted the action, but its resulting state could not be confirmed. Refresh before another action.',
    status: 409,
    uncertain: true,
  },
  REQUEST_ID_CONFLICT: {
    message: 'The request ID was already used for another operation.',
    status: 409,
  },
  ACTION_IN_PROGRESS: { message: 'Another action is running for this container.', status: 409 },
  RESOURCE_NOT_FOUND: { message: 'The selected Docker resource no longer exists.', status: 404 },
  LOGGING_DISABLED: { message: 'Logging is disabled for this container.', status: 422 },
  LOGS_UNAVAILABLE: {
    message:
      'This logging driver does not expose container logs. Check whether dual logging is enabled.',
    status: 422,
  },
  DRIVER_NOT_SUPPORTED: {
    message: 'This logging driver does not support reading container logs.',
    status: 422,
  },
  STREAM_LIMIT_EXCEEDED: {
    message: 'This host reached its concurrent log stream limit.',
    status: 429,
  },
  REQUEST_LIMIT_EXCEEDED: {
    message: 'This host is handling too many requests. Try again later.',
    status: 429,
  },
  ACTION_LIMIT_EXCEEDED: {
    message: 'This host reached its action limit. Try again later.',
    status: 429,
  },
  ENGINE_TIMEOUT: {
    message:
      'Docker did not respond before its operation deadline. The action result may be unknown; refresh before retrying.',
    status: 504,
    uncertain: true,
  },
  ENGINE_UNREACHABLE: {
    message:
      'The agent could not reach its local Docker socket. Check socket path and permissions.',
    status: 503,
    uncertain: true,
  },
  ENGINE_VERSION_UNSUPPORTED: {
    message: 'This Docker Engine API version is not supported by the agent.',
    status: 502,
  },
  ENGINE_PLATFORM_UNSUPPORTED: {
    message: 'This agent version supports Linux Docker hosts.',
    status: 502,
  },
  RESOURCE_LIMIT_EXCEEDED: {
    message: 'This host exceeds the configured agent resource limit.',
    status: 502,
  },
  RESPONSE_LIMIT_EXCEEDED: {
    message: 'The Docker response exceeded the configured size limit.',
    status: 502,
  },
  CLIENT_UNAUTHORIZED: {
    message: 'The agent rejected the backend client certificate identity.',
    status: 502,
  },
  INVALID_INPUT: { message: 'The agent rejected invalid request parameters.', status: 400 },
};

export class HttpsAgentTransport implements AgentTransport {
  private agents = new Map<string, https.Agent>();
  constructor(private credentials: AppConfig['credentials']) {
    for (const [name, credential] of Object.entries(credentials)) {
      this.agents.set(
        name,
        new https.Agent({
          keepAlive: true,
          maxSockets: 12,
          ca: readFileSync(credential.caFile),
          cert: readFileSync(credential.certFile),
          key: readFileSync(credential.keyFile),
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
        }),
      );
    }
  }
  private async request(
    host: HostConfig,
    path: string,
    body?: object,
    signal?: AbortSignal,
    streaming = false,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const endpoint = new URL(host.agentUrl);
      const hostname = endpoint.hostname.startsWith('[')
        ? endpoint.hostname.slice(1, -1)
        : endpoint.hostname;
      const servername =
        this.credentials[host.credentialRef]?.serverName || (isIP(hostname) ? undefined : hostname);
      const payload = body ? JSON.stringify(body) : undefined;
      let incoming: IncomingMessage | undefined;
      const request = https.request(
        {
          protocol: 'https:',
          hostname,
          port: endpoint.port || 443,
          path,
          method: payload ? 'POST' : 'GET',
          agent: this.agents.get(host.credentialRef),
          servername,
          signal,
          headers: payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
                accept: 'application/json',
              }
            : { accept: streaming ? 'application/x-ndjson' : 'application/json' },
        },
        (response) => {
          incoming = response;
          response.once('end', () => clearTimeout(deadline));
          response.once('close', () => clearTimeout(deadline));
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            void (async () => {
              let bytes = 0;
              const chunks: Buffer[] = [];
              try {
                for await (const chunk of response) {
                  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                  bytes += data.length;
                  if (bytes > 16384) {
                    response.destroy();
                    break;
                  }
                  chunks.push(data);
                }
                let code: unknown;
                try {
                  code = JSON.parse(Buffer.concat(chunks).toString('utf8')).code;
                } catch {
                  /* Unknown responses receive a generic safe message. */
                }
                const known =
                  typeof code === 'string' && Object.hasOwn(knownFailures, code)
                    ? knownFailures[code]
                    : undefined;
                reject(
                  known
                    ? new AgentError(
                        known.message,
                        String(code),
                        !!payload && !!known.uncertain,
                        known.status,
                      )
                    : new AgentError(
                        `The agent rejected the request (HTTP ${response.statusCode || 'unknown'}).`,
                        'AGENT_REJECTED',
                        !!payload && (response.statusCode || 500) >= 500,
                      ),
                );
              } catch (error) {
                reject(error);
              }
            })();
            return;
          }
          if (streaming) {
            if (
              !String(response.headers['content-type'])
                .toLowerCase()
                .startsWith('application/x-ndjson')
            ) {
              response.destroy();
              reject(
                new AgentError(
                  'The agent did not return a supported log stream.',
                  'INVALID_AGENT_RESPONSE',
                ),
              );
              return;
            }
            clearTimeout(deadline);
          }
          resolve(response);
        },
      );
      // This is an absolute deadline, including a response that trickles bytes forever.
      // Docker's normal stop grace is 10 seconds; mutation budgets must outlive it.
      const deadline = setTimeout(
        () => {
          const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
          request.destroy(error);
          incoming?.destroy(error);
        },
        payload ? Math.max(host.timeoutMs, 30000) : host.timeoutMs,
      );
      deadline.unref();
      request.on('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      request.end(payload);
    });
  }
  private async json(host: HostConfig, path: string, body?: object): Promise<unknown> {
    try {
      const response = await this.request(host, path, body);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > maxBody) {
          response.destroy();
          throw new AgentError(
            'The agent response exceeded the size limit.',
            'INVALID_AGENT_RESPONSE',
          );
        }
        chunks.push(data);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new AgentError('The agent returned invalid JSON.', 'INVALID_AGENT_RESPONSE');
      }
    } catch (error) {
      throw connectionError(error, !!body);
    }
  }
  async health(host: HostConfig): Promise<{ hostId: string; version: number }> {
    const result = record(await this.json(host, '/v1/health'));
    if (result.hostId !== host.id || result.version !== 1)
      throw new AgentError(
        'The agent host ID or protocol version does not match this configuration.',
        'AGENT_IDENTITY_MISMATCH',
      );
    return { hostId: host.id, version: 1 };
  }
  async snapshot(host: HostConfig): Promise<Snapshot> {
    return parseSnapshot(await this.json(host, '/v1/snapshot'));
  }
  async stats(host: HostConfig): Promise<Stats[]> {
    return parseStats(await this.json(host, '/v1/stats'));
  }
  async action(
    host: HostConfig,
    id: string,
    action: Action,
    requestId: string,
    actor: string,
  ): Promise<void> {
    const result = record(
      await this.json(host, `/v1/containers/${id}/${action}`, { requestId, actor }),
    );
    if (result.ok !== true)
      throw new AgentError(
        'The agent did not confirm the action result.',
        'ACTION_RESULT_UNKNOWN',
        true,
      );
  }
  async logs(
    host: HostConfig,
    id: string,
    tail: number,
    follow: boolean,
    signal: AbortSignal,
  ): Promise<Readable> {
    try {
      return await this.request(
        host,
        `/v1/containers/${id}/logs?tail=${tail}&follow=${follow ? 'true' : 'false'}`,
        undefined,
        signal,
        true,
      );
    } catch (error) {
      throw connectionError(error);
    }
  }
  close(): void {
    for (const agent of this.agents.values()) agent.destroy();
  }
}
