import { readFileSync } from 'node:fs';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import YAML from 'yaml';
import type { AppConfig, PublicConfig } from '../shared/types.js';
import { ApiError } from './errors.js';

export const configSchema = JSON.parse(
  readFileSync(new URL('../../config.schema.json', import.meta.url), 'utf8'),
);
const validator = new Ajv({ allErrors: true, strict: true }).compile(configSchema);
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export const isLoopbackHost = (value: string) => loopbackHosts.has(value.toLowerCase());

function configError(message: string): never {
  throw new ApiError(400, 'INVALID_CONFIG', message);
}
function safeUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return configError(`${field}: expected an absolute URL.`);
  }
  if (url.username || url.password || url.hash || url.search || url.pathname !== '/')
    configError(`${field}: use a URL origin without credentials, path, query or fragment.`);
  return url;
}

export function validateConfig(
  value: unknown,
  allowDev = process.env.ALLOW_DEV_MODE === '1',
): AppConfig {
  if (!validator(value)) {
    const errors = validator.errors
      ?.map(
        (error) =>
          `${error.instancePath || '/'}${error.keyword === 'additionalProperties' ? `/${String(error.params.additionalProperty)}` : ''}: ${error.message}`,
      )
      .join('; ');
    configError(errors || 'Invalid configuration.');
  }
  const config = structuredClone(value) as AppConfig;
  const base = safeUrl(config.baseUrl, 'baseUrl');
  if (config.auth.usernameHeader.toLowerCase() === config.auth.subjectHeader.toLowerCase())
    configError('auth.subjectHeader: must differ from usernameHeader.');
  if (config.auth.mode === 'proxy') {
    if (base.protocol !== 'https:') configError('baseUrl: proxy authentication requires HTTPS.');
    if (!config.server.tls)
      configError('server.tls: proxy authentication requires mutual TLS and allowedProxyNames.');
  } else {
    if (!allowDev || !isLoopbackHost(config.server.host) || !isLoopbackHost(base.hostname))
      configError(
        'auth.mode: development requires ALLOW_DEV_MODE=1 and a loopback listener/baseUrl.',
      );
    if (!['http:', 'https:'].includes(base.protocol))
      configError('baseUrl: development requires HTTP or HTTPS.');
  }
  const ids = new Set<string>();
  for (const [index, host] of config.hosts.entries()) {
    if (ids.has(host.id)) configError(`hosts/${index}/id: duplicate host ID.`);
    ids.add(host.id);
    const url = safeUrl(host.agentUrl, `hosts/${index}/agentUrl`);
    if (url.protocol !== 'https:')
      configError(`hosts/${index}/agentUrl: agents require HTTPS with mutual TLS.`);
    if (!Object.hasOwn(config.credentials, host.credentialRef))
      configError(`hosts/${index}/credentialRef: unknown credential reference.`);
  }
  if (config.logs.defaultTail > config.logs.maxTail)
    configError('logs/defaultTail: must not exceed maxTail.');
  if (config.logs.maxLineBytes > config.logs.maxBufferBytes)
    configError('logs/maxLineBytes: must not exceed maxBufferBytes.');
  if (config.logs.maxStreamsPerUser > config.logs.maxStreamsTotal)
    configError('logs/maxStreamsPerUser: must not exceed maxStreamsTotal.');
  return config;
}

export function parseConfig(bytes: string, path: string, allowDev?: boolean): AppConfig {
  let value: unknown;
  try {
    const extension = extname(path).toLowerCase();
    if (extension === '.json') value = JSON.parse(bytes);
    else if (extension === '.yml' || extension === '.yaml') {
      const doc = YAML.parseDocument(bytes, { uniqueKeys: true, maxAliasCount: 0 } as Parameters<
        typeof YAML.parseDocument
      >[1]);
      if (doc.errors.length) throw new Error(doc.errors[0].message);
      value = doc.toJS({ maxAliasCount: 0 });
    } else configError('CONFIG_FILE: expected one .json, .yml or .yaml file.');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    configError(
      `CONFIG_FILE: parsing failed (${error instanceof SyntaxError ? 'invalid JSON' : 'invalid YAML'}).`,
    );
  }
  return validateConfig(value, allowDev);
}

export function revisionOf(bytes: string): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}
function immutablePart(config: AppConfig): string {
  const { hosts: _hosts, polling: _polling, logs: _logs, ...immutable } = config;
  return JSON.stringify(immutable);
}

export class ConfigStore {
  private configValue: AppConfig;
  private revisionValue: string;
  private queue = Promise.resolve();
  private readonly immutable: string;
  private listeners = new Set<(config: AppConfig) => void>();
  private constructor(
    public readonly path: string,
    bytes: string,
    private allowDev: boolean,
  ) {
    this.configValue = parseConfig(bytes, path, allowDev);
    this.revisionValue = revisionOf(bytes);
    this.immutable = immutablePart(this.configValue);
  }
  static async load(
    path: string,
    allowDev = process.env.ALLOW_DEV_MODE === '1',
  ): Promise<ConfigStore> {
    const absolute = resolve(path);
    const bytes = await readFile(absolute, 'utf8');
    if (Buffer.byteLength(bytes) > 1048576) configError('CONFIG_FILE: maximum size is 1 MiB.');
    return new ConfigStore(absolute, bytes, allowDev);
  }
  get current(): AppConfig {
    return structuredClone(this.configValue);
  }
  publicConfig(): PublicConfig {
    const { hosts, polling, logs, baseUrl, auth } = this.current;
    return {
      version: 1,
      hosts,
      credentialRefs: Object.keys(this.configValue.credentials),
      polling,
      logs,
      baseUrl,
      auth: { mode: auth.mode },
      revision: this.revisionValue,
    };
  }
  subscribe(listener: (config: AppConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private adopt(config: AppConfig, bytes: string): void {
    this.configValue = config;
    this.revisionValue = revisionOf(bytes);
    for (const listener of this.listeners) listener(this.current);
  }
  private checkImmutable(config: AppConfig): void {
    if (immutablePart(config) !== this.immutable)
      throw new ApiError(
        409,
        'RESTART_REQUIRED',
        'Server, authentication, credential catalog, base URL and storage changes require a restart.',
      );
  }
  reload(): Promise<PublicConfig> {
    return this.serial(async () => {
      const bytes = await readFile(this.path, 'utf8');
      if (Buffer.byteLength(bytes) > 1048576) configError('CONFIG_FILE: maximum size is 1 MiB.');
      const config = parseConfig(bytes, this.path, this.allowDev);
      this.checkImmutable(config);
      if (revisionOf(bytes) !== this.revisionValue) this.adopt(config, bytes);
      return this.publicConfig();
    });
  }
  update(body: unknown, expectedRevision: string | undefined): Promise<PublicConfig> {
    return this.serial(async () => {
      if (!expectedRevision)
        throw new ApiError(
          428,
          'REVISION_REQUIRED',
          'If-Match is required. Reload the configuration first.',
        );
      if (!body || typeof body !== 'object' || Array.isArray(body))
        configError('configuration: expected an object.');
      const update = body as Record<string, unknown>;
      if (Object.keys(update).sort().join(',') !== 'hosts,logs,polling')
        configError('configuration: exactly hosts, polling and logs are editable.');
      const lockPath = `${this.path}.lock`;
      let lock;
      try {
        lock = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new ApiError(
            409,
            'CONFIG_LOCKED',
            'Configuration is locked. Complete the other edit, then reload.',
          );
        throw error;
      }
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await lock.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        );
        await lock.sync();
        const before = await readFile(this.path, 'utf8');
        if (revisionOf(before) !== expectedRevision)
          throw new ApiError(
            409,
            'CONFIG_CONFLICT',
            'Configuration changed. Reload before saving your edit.',
          );
        const diskConfig = parseConfig(before, this.path, this.allowDev);
        this.checkImmutable(diskConfig);
        const candidate = validateConfig({ ...diskConfig, ...update }, this.allowDev);
        const next =
          extname(this.path).toLowerCase() === '.json'
            ? `${JSON.stringify(candidate, null, 2)}\n`
            : YAML.stringify(candidate);
        const file = await open(temp, 'wx', 0o600);
        try {
          await file.writeFile(next, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        if (revisionOf(await readFile(this.path, 'utf8')) !== expectedRevision)
          throw new ApiError(
            409,
            'CONFIG_CONFLICT',
            'Configuration changed while saving. Reload before saving your edit.',
          );
        await rename(temp, this.path);
        // POSIX directory fsync persists the rename. Windows does not support opening a directory.
        if (process.platform !== 'win32') {
          const directory = await open(dirname(this.path), 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        }
        this.adopt(candidate, next);
        return this.publicConfig();
      } finally {
        await unlink(temp).catch(() => undefined);
        await lock.close();
        await unlink(lockPath);
      }
    });
  }
}
