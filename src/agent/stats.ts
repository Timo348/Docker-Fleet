import type { Stats } from '../shared/types.js';

export interface CpuSample {
  cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
  system_cpu_usage?: number;
  online_cpus?: number;
}
export interface DockerStats {
  read?: string;
  preread?: string;
  cpu_stats?: CpuSample;
  precpu_stats?: CpuSample;
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
}
function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Linux Docker CLI semantics: 100% is one logical CPU, so multicore use may exceed 100%. */
export function calculateStats(id: string, sample: DockerStats, previous?: CpuSample): Stats {
  const current = sample.cpu_stats;
  const before = previous ?? sample.precpu_stats;
  let cpuPercent: number | null = null;
  const currentUsage = current?.cpu_usage?.total_usage,
    previousUsage = before?.cpu_usage?.total_usage;
  const currentSystem = current?.system_cpu_usage,
    previousSystem = before?.system_cpu_usage;
  const cpus = current?.online_cpus || current?.cpu_usage?.percpu_usage?.length;
  if (
    valid(currentUsage) &&
    valid(previousUsage) &&
    valid(currentSystem) &&
    valid(previousSystem) &&
    previousSystem > 0 &&
    valid(cpus) &&
    cpus > 0 &&
    currentSystem > previousSystem &&
    currentUsage >= previousUsage
  ) {
    cpuPercent = ((currentUsage - previousUsage) / (currentSystem - previousSystem)) * cpus * 100;
    if (!Number.isFinite(cpuPercent)) cpuPercent = null;
  }
  const memory = sample.memory_stats;
  let memoryBytes: number | null = valid(memory?.usage) ? memory.usage : null;
  if (memoryBytes !== null) {
    const cache = memory?.stats?.['total_inactive_file'] ?? memory?.stats?.['inactive_file'];
    if (valid(cache) && cache <= memoryBytes) memoryBytes -= cache;
  }
  const memoryLimitBytes = valid(memory?.limit) && memory.limit > 0 ? memory.limit : null;
  return { id, cpuPercent, memoryBytes, memoryLimitBytes };
}
