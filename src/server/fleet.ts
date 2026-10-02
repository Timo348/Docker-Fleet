import type { AppConfig, HostConfig, HostStatus, Resources, Snapshot } from '../shared/types.js';
import type { AgentTransport } from './agent-client.js';
import { ApiError } from './errors.js';

interface HostEntry {
  host: HostConfig;
  status: HostStatus;
  snapshot: Snapshot | null;
  generation: number;
  inventoryAt?: number;
  inventory?: Promise<void>;
  stats?: Promise<void>;
}
export class Fleet {
  private entries = new Map<string, HostEntry>();
  private timers: NodeJS.Timeout[] = [];
  private config: AppConfig;
  private running = false;
  private generation = 0;
  constructor(
    config: AppConfig,
    private transport: AgentTransport,
  ) {
    this.config = config;
    this.configure(config);
  }
  configure(config: AppConfig): void {
    this.config = config;
    this.generation++;
    const next = new Map<string, HostEntry>();
    for (const host of config.hosts) {
      const prior = this.entries.get(host.id);
      const sameConnection =
        prior &&
        prior.host.agentUrl === host.agentUrl &&
        prior.host.credentialRef === host.credentialRef &&
        prior.host.enabled === host.enabled &&
        prior.host.timeoutMs === host.timeoutMs;
      const entry: HostEntry = sameConnection
        ? { ...prior, host, generation: this.generation, inventory: undefined, stats: undefined }
        : {
            host,
            snapshot: null,
            generation: this.generation,
            status: {
              id: host.id,
              name: host.name,
              enabled: host.enabled,
              state: host.enabled ? 'connecting' : 'disabled',
              lastSuccess: null,
              error: null,
              stale: host.enabled,
            },
          };
      entry.status = {
        ...entry.status,
        name: host.name,
        enabled: host.enabled,
        ...(host.enabled ? {} : { state: 'disabled' as const, stale: false, error: null }),
      };
      next.set(host.id, entry);
    }
    this.entries = next;
    if (this.running) {
      this.schedule();
      void this.refreshAll();
    }
  }
  start(): void {
    this.running = true;
    this.schedule();
    void this.refreshAll();
  }
  private schedule(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [
      setInterval(() => {
        void this.refreshAll();
      }, this.config.polling.inventoryMs),
      setInterval(() => {
        for (const entry of this.entries.values()) void this.refreshStats(entry);
      }, this.config.polling.statsMs),
    ];
    for (const timer of this.timers) timer.unref();
  }
  private current(entry: HostEntry): boolean {
    return this.entries.get(entry.host.id) === entry && entry.host.enabled;
  }
  private failure(entry: HostEntry, error: unknown): void {
    if (this.current(entry))
      entry.status = {
        ...entry.status,
        state: 'offline',
        stale: true,
        error: error instanceof ApiError ? error.message : 'The agent could not be reached.',
      };
  }
  host(id: string): HostConfig {
    const entry = this.entries.get(id);
    if (!entry) throw new ApiError(404, 'HOST_NOT_FOUND', 'The configured host does not exist.');
    if (!entry.host.enabled)
      throw new ApiError(
        409,
        'HOST_DISABLED',
        'This host is disabled. Enable it in configuration first.',
      );
    return structuredClone(entry.host);
  }
  async refreshHost(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry?.host.enabled) return;
    if (entry.inventory) return entry.inventory;
    const job = (async () => {
      try {
        const health = await this.transport.health(entry.host);
        if (health.hostId !== entry.host.id || health.version !== 1)
          throw new ApiError(
            502,
            'AGENT_IDENTITY_MISMATCH',
            'The agent identity does not match the host configuration.',
          );
        const snapshot = await this.transport.snapshot(entry.host);
        if (!this.current(entry)) return;
        // Inventory responses must never reintroduce a previous statistics sample.
        for (const container of snapshot.containers) {
          container.cpuPercent = null;
          container.memoryBytes = null;
          container.memoryLimitBytes = null;
        }
        entry.snapshot = snapshot;
        entry.inventoryAt = Date.now();
        entry.status = {
          ...entry.status,
          state: 'online',
          stale: false,
          lastSuccess: new Date().toISOString(),
          error: null,
          engineVersion: snapshot.engineVersion,
        };
        await this.refreshStats(entry);
      } catch (error) {
        this.failure(entry, error);
      } finally {
        entry.inventory = undefined;
      }
    })();
    entry.inventory = job;
    return job;
  }
  private async refreshStats(entry: HostEntry): Promise<void> {
    if (!entry.host.enabled || !entry.snapshot || entry.stats) return entry.stats;
    const job = (async () => {
      try {
        const stats = await this.transport.stats(entry.host);
        if (!this.current(entry) || !entry.snapshot) return;
        const samples = new Map(stats.map((sample) => [sample.id, sample]));
        for (const container of entry.snapshot.containers) {
          const sample = container.state === 'running' ? samples.get(container.id) : undefined;
          container.cpuPercent = sample?.cpuPercent ?? null;
          container.memoryBytes = sample?.memoryBytes ?? null;
          container.memoryLimitBytes = sample?.memoryLimitBytes ?? null;
        }
      } catch (error) {
        this.failure(entry, error);
      } finally {
        entry.stats = undefined;
      }
    })();
    entry.stats = job;
    return job;
  }
  async refreshAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.refreshHost(id)));
  }
  async testHost(id: string): Promise<{ ok: boolean; message: string }> {
    const host = this.host(id);
    try {
      const health = await this.transport.health(host);
      if (health.hostId !== host.id || health.version !== 1)
        throw new ApiError(
          502,
          'AGENT_IDENTITY_MISMATCH',
          'The agent identity does not match this host.',
        );
      return { ok: true, message: 'Agent connection, TLS identity and host ID verified.' };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof ApiError ? error.message : 'The agent connection failed.',
      };
    }
  }
  resources(): Resources {
    const result: Resources = { containers: [], images: [], volumes: [], hosts: [] };
    for (const entry of this.entries.values()) {
      const status = { ...entry.status };
      if (
        entry.host.enabled &&
        entry.inventoryAt &&
        Date.now() - entry.inventoryAt >
          Math.max(this.config.polling.inventoryMs * 2, entry.host.timeoutMs * 2)
      )
        status.stale = true;
      result.hosts.push(status);
      if (!entry.host.enabled || !entry.snapshot) continue;
      result.containers.push(
        ...entry.snapshot.containers.map((item) => ({ ...item, hostId: entry.host.id })),
      );
      result.images.push(
        ...entry.snapshot.images.map((item) => ({ ...item, hostId: entry.host.id })),
      );
      result.volumes.push(
        ...entry.snapshot.volumes.map((item) => ({ ...item, hostId: entry.host.id })),
      );
    }
    return structuredClone(result);
  }
  close(): void {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
