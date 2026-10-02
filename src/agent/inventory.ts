import type { Container, Image, Snapshot, Stats, Volume } from '../shared/types.js';
import { AgentError, DockerClient, mapLimit } from './docker.js';
import { calculateStats, type CpuSample, type DockerStats } from './stats.js';

export interface DockerContainerSummary {
  Id: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  State?: string;
  Status?: string;
  Ports?: { IP?: string; PrivatePort: number; PublicPort?: number; Type?: string }[];
  Labels?: Record<string, string>;
  Mounts?: { Type?: string; Name?: string }[];
}
export interface DockerInspect {
  Id: string;
  Name?: string;
  Image?: string;
  State?: { Status?: string; Running?: boolean; StartedAt?: string; Health?: { Status?: string } };
  Config?: { Image?: string; Tty?: boolean; Labels?: Record<string, string> };
  HostConfig?: { Memory?: number; LogConfig?: { Type?: string } };
}
interface DockerImage {
  Id: string;
  RepoTags?: string[] | null;
  Size?: number;
  Created?: number;
}
interface DockerVolume {
  Name: string;
  Driver?: string;
  Scope?: string;
  Labels?: Record<string, string>;
}
const text = (value: unknown, length = 1024): string =>
  typeof value === 'string' ? value.slice(0, length) : '';
const label = (labels: Record<string, string> | undefined, key: string) =>
  text(labels?.[key], 255) || null;
const fullId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value: string | undefined): string | null =>
  value && !value.startsWith('0001-') && Number.isFinite(Date.parse(value)) ? value : null;

export function projectContainer(
  item: DockerContainerSummary,
  inspect: DockerInspect,
  hostId: string,
): Container {
  const healthValue = inspect.State?.Health?.Status;
  const health =
    healthValue && ['starting', 'healthy', 'unhealthy'].includes(healthValue) ? healthValue : null;
  return {
    id: item.Id,
    hostId,
    name: text(inspect.Name || item.Names?.[0] || item.Id, 256)
      .replace(/^\//, '')
      .slice(0, 255),
    image: text(inspect.Config?.Image || item.Image),
    imageId: text(inspect.Image || item.ImageID),
    state: text(inspect.State?.Status || item.State, 32),
    status: text(item.Status, 256),
    health,
    cpuPercent: null,
    memoryBytes: null,
    memoryLimitBytes:
      typeof inspect.HostConfig?.Memory === 'number' && inspect.HostConfig.Memory > 0
        ? inspect.HostConfig.Memory
        : null,
    ports: (item.Ports ?? []).slice(0, 256).map((port) => ({
      ip: text(port.IP, 64),
      privatePort: port.PrivatePort,
      ...(port.PublicPort === undefined ? {} : { publicPort: port.PublicPort }),
      type: text(port.Type || 'tcp', 16),
    })),
    composeProject: label(inspect.Config?.Labels || item.Labels, 'com.docker.compose.project'),
    composeService: label(inspect.Config?.Labels || item.Labels, 'com.docker.compose.service'),
    startedAt: date(inspect.State?.StartedAt),
  };
}

export class Inventory {
  private snapshotCache: Snapshot | undefined;
  private snapshotExpiry = 0;
  private snapshotPending: Promise<Snapshot> | undefined;
  private statsCache: Stats[] | undefined;
  private statsExpiry = 0;
  private statsPending: Promise<Stats[]> | undefined;
  private readonly previous = new Map<string, { cpu: CpuSample; startedAt: string | null }>();
  constructor(
    readonly docker: DockerClient,
    readonly hostId: string,
    readonly maxResources = 5000,
  ) {}

  invalidate(id?: string): void {
    this.snapshotExpiry = 0;
    this.statsExpiry = 0;
    if (id) this.previous.delete(id);
  }
  private bound<T>(items: T[] | undefined | null): T[] {
    if (!Array.isArray(items))
      throw new AgentError('ENGINE_INVALID_RESPONSE', 'Docker returned an invalid resource list.');
    if (items.length > this.maxResources)
      throw new AgentError(
        'RESOURCE_LIMIT_EXCEEDED',
        'The host has more resources than this agent allows.',
        413,
      );
    return items;
  }
  snapshot(): Promise<Snapshot> {
    if (this.snapshotCache && Date.now() < this.snapshotExpiry)
      return Promise.resolve(this.snapshotCache);
    if (this.snapshotPending) return this.snapshotPending;
    this.snapshotPending = this.collectSnapshot()
      .then((snapshot) => {
        this.snapshotCache = snapshot;
        this.snapshotExpiry = Date.now() + 1000;
        return snapshot;
      })
      .finally(() => {
        this.snapshotPending = undefined;
      });
    return this.snapshotPending;
  }
  private async collectSnapshot(): Promise<Snapshot> {
    const [engine, summaries, rawImages, rawVolumes] = await Promise.all([
      this.docker.version(),
      this.docker.json<DockerContainerSummary[]>('GET', '/containers/json?all=true'),
      this.docker.json<DockerImage[]>('GET', '/images/json?all=true'),
      this.docker.json<{ Volumes?: DockerVolume[] | null }>('GET', '/volumes'),
    ]);
    const summariesSafe = this.bound(summaries).filter((item) => fullId(item.Id));
    const containers = (
      await mapLimit(summariesSafe, 8, async (item) => {
        try {
          return projectContainer(
            item,
            await this.docker.json<DockerInspect>('GET', `/containers/${item.Id}/json`),
            this.hostId,
          );
        } catch (error) {
          if (error instanceof AgentError && error.status === 404) return null;
          throw error;
        }
      })
    ).filter((item): item is Container => item !== null);
    const ids = new Set(containers.map((item) => item.id));
    const imageContainers = new Map<string, string[]>();
    const volumeContainers = new Map<string, string[]>();
    for (const container of containers) {
      const references = imageContainers.get(container.imageId) ?? [];
      references.push(container.id);
      imageContainers.set(container.imageId, references);
    }
    let associations = 0;
    for (const container of summariesSafe) {
      if (!ids.has(container.Id)) continue;
      const names = new Set(
        (container.Mounts ?? [])
          .filter((mount) => mount.Type === 'volume' && typeof mount.Name === 'string')
          .map((mount) => mount.Name!),
      );
      associations += names.size;
      if (associations > 100_000)
        throw new AgentError(
          'RESOURCE_LIMIT_EXCEEDED',
          'The host has more volume associations than this agent allows.',
          413,
        );
      for (const name of names) {
        const references = volumeContainers.get(name) ?? [];
        references.push(container.Id);
        volumeContainers.set(name, references);
      }
    }
    const images: Image[] = this.bound(rawImages).map((item) => ({
      id: text(item.Id),
      hostId: this.hostId,
      tags: (item.RepoTags ?? [])
        .filter((tag) => typeof tag === 'string' && tag !== '<none>:<none>')
        .slice(0, 256)
        .map((tag) => text(tag)),
      sizeBytes: typeof item.Size === 'number' && item.Size >= 0 ? item.Size : 0,
      createdAt:
        typeof item.Created === 'number' &&
        Number.isFinite(item.Created) &&
        Number.isFinite(new Date(item.Created * 1000).getTime())
          ? new Date(item.Created * 1000).toISOString()
          : '',
      containerIds: imageContainers.get(item.Id) ?? [],
    }));
    const volumes: Volume[] = this.bound(rawVolumes.Volumes ?? []).map((item) => ({
      id: text(item.Name, 255),
      hostId: this.hostId,
      name: text(item.Name, 255),
      driver: text(item.Driver, 255),
      scope: text(item.Scope, 64),
      sizeBytes: null,
      containerIds: volumeContainers.get(item.Name) ?? [],
      composeProject: label(item.Labels, 'com.docker.compose.project'),
    }));
    const snapshot: Snapshot = {
      containers,
      images,
      volumes,
      collectedAt: new Date().toISOString(),
      engineVersion: text(engine.Version, 128),
    };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > this.docker.maxResponseBytes)
      throw new AgentError(
        'RESPONSE_LIMIT_EXCEEDED',
        'The normalized host snapshot exceeded the configured size limit.',
        413,
      );
    return snapshot;
  }
  stats(): Promise<Stats[]> {
    if (this.statsCache && Date.now() < this.statsExpiry) return Promise.resolve(this.statsCache);
    if (this.statsPending) return this.statsPending;
    this.statsPending = this.collectStats()
      .then((stats) => {
        this.statsCache = stats;
        this.statsExpiry = Date.now() + 1000;
        return stats;
      })
      .finally(() => {
        this.statsPending = undefined;
      });
    return this.statsPending;
  }
  private async collectStats(): Promise<Stats[]> {
    const snapshot = await this.snapshot();
    const running = snapshot.containers.filter((container) => container.state === 'running');
    const runningIds = new Set(running.map((container) => container.id));
    for (const id of this.previous.keys()) if (!runningIds.has(id)) this.previous.delete(id);
    return mapLimit(running, 8, async (container) => {
      try {
        const sample = await this.docker.json<DockerStats>(
          'GET',
          `/containers/${container.id}/stats?stream=false&one-shot=true`,
        );
        const before = this.previous.get(container.id);
        const previous = before?.startedAt === container.startedAt ? before.cpu : undefined;
        const stats = calculateStats(container.id, sample, previous);
        if (sample.cpu_stats)
          this.previous.set(container.id, {
            cpu: sample.cpu_stats,
            startedAt: container.startedAt,
          });
        return stats;
      } catch (error) {
        this.previous.delete(container.id);
        if (error instanceof AgentError && [404, 409].includes(error.status))
          return { id: container.id, cpuPercent: null, memoryBytes: null, memoryLimitBytes: null };
        throw error;
      }
    });
  }
}
