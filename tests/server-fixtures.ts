import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { AppConfig, HostConfig, Snapshot, Stats } from '../src/shared/types.js';
import type { AgentTransport } from '../src/server/agent-client.js';

export const containerId = 'a'.repeat(64);
export const otherId = 'b'.repeat(64);
export function snapshot(id = containerId): Snapshot {
  return {
    containers: [
      {
        id,
        name: 'same-name',
        image: 'alpine:3',
        imageId: `sha256:${'c'.repeat(64)}`,
        state: 'running',
        status: 'Up',
        health: null,
        cpuPercent: null,
        memoryBytes: null,
        memoryLimitBytes: null,
        ports: [],
        composeProject: 'demo',
        composeService: 'web',
        startedAt: '2026-10-02T10:00:00.000Z',
      },
    ],
    images: [
      {
        id: `sha256:${'c'.repeat(64)}`,
        tags: ['alpine:3'],
        sizeBytes: 8192,
        createdAt: '2026-10-01T10:00:00.000Z',
        containerIds: [id],
      },
    ],
    volumes: [
      {
        id: 'demo_data',
        name: 'demo_data',
        driver: 'local',
        scope: 'local',
        containerIds: [id],
        composeProject: 'demo',
        sizeBytes: null,
      },
    ],
    collectedAt: new Date().toISOString(),
    engineVersion: '29.0.0',
  };
}
export class FakeTransport implements AgentTransport {
  actionCalls: { host: string; id: string; action: string; requestId: string; actor: string }[] =
    [];
  snapshotCalls: string[] = [];
  failHosts = new Set<string>();
  healthIds = new Map<string, string>();
  snapshots = new Map<string, Snapshot>();
  actionFailure: Error | undefined;
  actionWait: Promise<void> | undefined;
  streamFactory: () => Readable = () =>
    Readable.from([
      `${JSON.stringify({ stream: 'stdout', text: '<script>alert(1)</script>\u001b[31m red\u001b[0m', timestamp: '2026-10-02T10:00:00Z' })}\n`,
    ]);
  async health(host: HostConfig) {
    if (this.failHosts.has(host.id)) throw new Error('unreachable');
    return { hostId: this.healthIds.get(host.id) || host.id, version: 1 };
  }
  async snapshot(host: HostConfig) {
    this.snapshotCalls.push(host.id);
    if (this.failHosts.has(host.id)) throw new Error('unreachable');
    return structuredClone(this.snapshots.get(host.id) || snapshot());
  }
  async stats(_host: HostConfig): Promise<Stats[]> {
    return [{ id: containerId, cpuPercent: 25, memoryBytes: 4096, memoryLimitBytes: 8192 }];
  }
  async action(host: HostConfig, id: string, action: string, requestId: string, actor: string) {
    this.actionCalls.push({ host: host.id, id, action, requestId, actor });
    if (this.actionWait) await this.actionWait;
    if (this.actionFailure) throw this.actionFailure;
  }
  async logs(_host: HostConfig, _id: string, _tail: number, _follow: boolean, signal: AbortSignal) {
    const stream = this.streamFactory();
    signal.addEventListener('abort', () => stream.destroy(), { once: true });
    return stream;
  }
}
export async function fixture(extension = '.json') {
  const directory = await mkdtemp(join(tmpdir(), 'docker-fleet-tests-'));
  const secretFile = join(directory, 'csrf.secret');
  await writeFile(secretFile, 's'.repeat(64));
  const config: AppConfig = {
    version: 1,
    server: { host: '127.0.0.1', port: 8080 },
    baseUrl: 'http://127.0.0.1:8080',
    auth: {
      mode: 'development',
      usernameHeader: 'X-Authentik-Username',
      subjectHeader: 'X-Authentik-Uid',
      allowedUsers: ['test-user'],
      csrfSecretFile: secretFile,
    },
    credentials: {
      first: {
        caFile: '/secrets/a-ca',
        certFile: '/secrets/a-cert',
        keyFile: '/secrets/a-key',
        serverName: 'agent-a',
      },
      second: {
        caFile: '/secrets/b-ca',
        certFile: '/secrets/b-cert',
        keyFile: '/secrets/b-key',
        serverName: 'agent-b',
      },
    },
    hosts: [
      {
        id: 'srv-1',
        name: 'SRV-1',
        agentUrl: 'https://agent-a:9443',
        enabled: true,
        credentialRef: 'first',
        timeoutMs: 3000,
      },
      {
        id: 'srv-2',
        name: 'SRV-2',
        agentUrl: 'https://agent-b:9443',
        enabled: true,
        credentialRef: 'second',
        timeoutMs: 3000,
      },
    ],
    polling: { inventoryMs: 10000, statsMs: 3000 },
    logs: {
      defaultTail: 100,
      maxTail: 1000,
      maxBufferBytes: 1048576,
      maxLineBytes: 16384,
      maxStreamsPerUser: 2,
      maxStreamsTotal: 4,
      maxStreamSeconds: 10,
    },
    storage: { dataDir: join(directory, 'data'), auditMaxBytes: 1048576 },
  };
  const configFile = join(directory, `config${extension}`);
  await writeFile(configFile, JSON.stringify(config, null, 2));
  return {
    directory,
    config,
    configFile,
    async cleanup() {
      const absolute = resolve(directory);
      if (
        !basename(absolute).startsWith('docker-fleet-tests-') ||
        resolve(tmpdir()) !== resolve(join(absolute, '..'))
      )
        throw new Error('Invalid test cleanup target.');
      await rm(absolute, { recursive: true, force: true });
    },
    async bytes() {
      return readFile(configFile, 'utf8');
    },
  };
}
