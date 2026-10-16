import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  ALLOWED_COMPOSE_FILENAMES,
  MAX_COMPOSE_BYTES,
  isValidComposeProjectName,
  sanitizeComposeContent,
  validateComposeYaml,
} from '../shared/compose.js';
import type { ComposeFileResponse, ComposeSaveResponse } from '../shared/types.js';
import { AgentError, type DockerClient } from './docker.js';
import type { DockerInspect, Inventory } from './inventory.js';

const execFileAsync = promisify(execFile);
const allowedNames = new Set<string>(ALLOWED_COMPOSE_FILENAMES);

export interface ComposeDeployContext {
  cwd: string;
  filePath: string;
  project: string;
  dockerSocket: string;
}

export type ComposeRunner = (context: ComposeDeployContext) => Promise<void>;

export interface ComposeUpdateInput {
  requestId: string;
  actor?: string;
  content: string;
  redeploy: boolean;
  expectedRevision?: string;
}

interface ResolvedComposeStack {
  project: string;
  service: string | null;
  workingDir: string;
  filePath: string;
  fileName: string;
}

interface ComposeDedupEntry {
  key: string;
  expires: number;
  settled: boolean;
  promise: Promise<ComposeSaveResponse>;
}

export function composeRevision(content: string): string {
  return `"${createHash('sha256').update(content, 'utf8').digest('hex')}"`;
}

function hasTraversalSegment(rawPath: string): boolean {
  if (!rawPath || rawPath.includes('\0') || rawPath.includes('\\')) return true;
  return rawPath.split('/').some((part) => part === '..');
}

function isWithinDirectory(childPath: string, parentDir: string): boolean {
  const normalizedParent = parentDir.endsWith(sep) ? parentDir : parentDir + sep;
  return childPath === parentDir || childPath.startsWith(normalizedParent);
}

export async function defaultComposeRunner(context: ComposeDeployContext): Promise<void> {
  try {
    await execFileAsync(
      'docker',
      ['compose', '-f', context.filePath, '-p', context.project, 'up', '-d'],
      {
        cwd: context.cwd,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          DOCKER_HOST: `unix://${context.dockerSocket}`,
        },
      },
    );
  } catch {
    throw new AgentError(
      'COMPOSE_DEPLOY_FAILED',
      'Docker Compose could not redeploy the stack (docker compose up -d failed).',
      502,
    );
  }
}

export class ComposeManager {
  private readonly locked = new Set<string>();
  private readonly dedup = new Map<string, ComposeDedupEntry>();
  private readonly runner: ComposeRunner;

  constructor(
    readonly docker: DockerClient,
    readonly inventory: Inventory,
    readonly options: {
      dockerSocket: string;
      composeDir?: string;
      composeRunner?: ComposeRunner;
      maxEntries?: number;
      onAuditLog?: (entry: {
        project: string;
        containerId: string;
        fileName: string;
        actor: string;
        redeployed: boolean;
        revision: string;
      }) => void;
    },
  ) {
    this.runner = options.composeRunner ?? defaultComposeRunner;
  }

  private async resolveStack(containerId: string): Promise<ResolvedComposeStack> {
    const inspect = await this.docker.json<DockerInspect>('GET', `/containers/${containerId}/json`);
    const labels = inspect.Config?.Labels ?? {};
    const project = labels['com.docker.compose.project']?.trim() || '';
    const service = labels['com.docker.compose.service']?.trim() || null;
    if (!project) {
      throw new AgentError(
        'COMPOSE_NOT_FOUND',
        'This container does not belong to a Docker Compose stack.',
        404,
      );
    }
    if (!isValidComposeProjectName(project)) {
      throw new AgentError(
        'COMPOSE_PATH_FORBIDDEN',
        'The Compose project name contains unsafe characters.',
        403,
      );
    }

    const rawWorkingDir = labels['com.docker.compose.project.working_dir']?.trim() || '';
    const rawConfigFiles = labels['com.docker.compose.project.config_files']?.trim() || '';
    const firstConfigFile = rawConfigFiles ? rawConfigFiles.split(',')[0]!.trim() : '';

    if (rawWorkingDir && hasTraversalSegment(rawWorkingDir)) {
      throw new AgentError(
        'COMPOSE_PATH_FORBIDDEN',
        'Path traversal in Compose working directory is not permitted.',
        403,
      );
    }
    if (firstConfigFile && hasTraversalSegment(firstConfigFile)) {
      throw new AgentError(
        'COMPOSE_PATH_FORBIDDEN',
        'Path traversal in Compose configuration file path is not permitted.',
        403,
      );
    }

    let baseReal: string | undefined;
    if (this.options.composeDir) {
      try {
        baseReal = await realpath(this.options.composeDir);
      } catch {
        throw new AgentError(
          'COMPOSE_FILE_MISSING',
          'The configured Compose base directory does not exist on this host.',
          404,
        );
      }
    }

    let candidateDir: string | undefined;
    let candidateFile: string | undefined;

    if (firstConfigFile) {
      if (isAbsolute(firstConfigFile)) {
        candidateFile = resolve(firstConfigFile);
        candidateDir = rawWorkingDir ? resolve(rawWorkingDir) : dirname(candidateFile);
      } else if (rawWorkingDir && isAbsolute(rawWorkingDir)) {
        candidateDir = resolve(rawWorkingDir);
        candidateFile = resolve(candidateDir, firstConfigFile);
      } else if (baseReal) {
        candidateDir = join(baseReal, project);
        candidateFile = resolve(candidateDir, firstConfigFile);
      } else {
        throw new AgentError(
          'COMPOSE_PATH_FORBIDDEN',
          'Relative Compose file path requires a valid absolute working directory.',
          403,
        );
      }
      if (dirname(candidateFile) !== candidateDir) {
        throw new AgentError(
          'COMPOSE_PATH_FORBIDDEN',
          'Compose file must reside directly inside its stack working directory.',
          403,
        );
      }
    } else if (rawWorkingDir) {
      if (!isAbsolute(rawWorkingDir)) {
        throw new AgentError(
          'COMPOSE_PATH_FORBIDDEN',
          'Compose working directory must be an absolute path.',
          403,
        );
      }
      candidateDir = resolve(rawWorkingDir);
    } else if (baseReal) {
      candidateDir = join(baseReal, project);
    } else {
      throw new AgentError(
        'COMPOSE_FILE_MISSING',
        'No Docker Compose file path is associated with this container.',
        404,
      );
    }

    let realWorkingDir: string;
    try {
      const dirStat = await lstat(candidateDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        throw new AgentError(
          'COMPOSE_PATH_FORBIDDEN',
          'Compose stack directory must be a regular directory, not a symlink.',
          403,
        );
      }
      realWorkingDir = await realpath(candidateDir);
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (baseReal && candidateDir !== join(baseReal, project)) {
        const fallbackDir = join(baseReal, project);
        try {
          const fallbackStat = await lstat(fallbackDir);
          if (fallbackStat.isSymbolicLink() || !fallbackStat.isDirectory()) {
            throw new AgentError(
              'COMPOSE_PATH_FORBIDDEN',
              'Compose stack directory must not be a symlink.',
              403,
            );
          }
          realWorkingDir = await realpath(fallbackDir);
          candidateFile = undefined;
        } catch (innerError) {
          if (innerError instanceof AgentError) throw innerError;
          throw new AgentError(
            'COMPOSE_FILE_MISSING',
            'The Docker Compose stack directory was not found on this host.',
            404,
          );
        }
      } else {
        throw new AgentError(
          'COMPOSE_FILE_MISSING',
          'The Docker Compose stack directory was not found on this host.',
          404,
        );
      }
    }

    if (baseReal && !isWithinDirectory(realWorkingDir, baseReal)) {
      throw new AgentError(
        'COMPOSE_PATH_FORBIDDEN',
        'The Compose stack directory is outside the allowed Compose root.',
        403,
      );
    }

    if (candidateFile) {
      const name = basename(candidateFile);
      if (!allowedNames.has(name)) {
        throw new AgentError(
          'COMPOSE_PATH_FORBIDDEN',
          'Only standard Docker Compose files (docker-compose.yml / compose.yml) may be accessed.',
          403,
        );
      }
      candidateFile = join(realWorkingDir, name);
    } else {
      for (const allowed of ALLOWED_COMPOSE_FILENAMES) {
        const probe = join(realWorkingDir, allowed);
        const exists = await stat(probe).then(
          (s) => s.isFile(),
          () => false,
        );
        if (exists) {
          candidateFile = probe;
          break;
        }
      }
      if (!candidateFile) {
        throw new AgentError(
          'COMPOSE_FILE_MISSING',
          'The Docker Compose file could not be found in the stack directory.',
          404,
        );
      }
    }

    let fileLstat;
    try {
      fileLstat = await lstat(candidateFile);
    } catch {
      throw new AgentError(
        'COMPOSE_FILE_MISSING',
        'The Docker Compose file could not be found on this host.',
        404,
      );
    }
    if (fileLstat.isSymbolicLink()) {
      throw new AgentError(
        'COMPOSE_PATH_FORBIDDEN',
        'Symbolic links are not permitted for Docker Compose files.',
        403,
      );
    }
    if (!fileLstat.isFile()) {
      throw new AgentError(
        'COMPOSE_FILE_MISSING',
        'The resolved Compose path is not a regular file.',
        404,
      );
    }

    const realFilePath = await realpath(candidateFile);
    if (dirname(realFilePath) !== realWorkingDir) {
      throw new AgentError(
        'COMPOSE_PATH_FORBIDDEN',
        'The Compose file resolved outside its stack working directory.',
        403,
      );
    }
    if (baseReal && !isWithinDirectory(realFilePath, baseReal)) {
      throw new AgentError(
        'COMPOSE_PATH_FORBIDDEN',
        'The Compose file is outside the allowed Compose root directory.',
        403,
      );
    }

    return {
      project,
      service,
      workingDir: realWorkingDir,
      filePath: realFilePath,
      fileName: basename(realFilePath),
    };
  }

  async get(containerId: string): Promise<ComposeFileResponse> {
    const stack = await this.resolveStack(containerId);
    let raw: string;
    try {
      raw = await readFile(stack.filePath, 'utf8');
    } catch {
      throw new AgentError(
        'COMPOSE_FILE_MISSING',
        'The Docker Compose file could not be read from the host.',
        404,
      );
    }
    const content = sanitizeComposeContent(raw);
    if (Buffer.byteLength(content, 'utf8') > MAX_COMPOSE_BYTES) {
      throw new AgentError(
        'RESPONSE_LIMIT_EXCEEDED',
        'The Compose file exceeds the maximum supported size of 512 KiB.',
        413,
      );
    }
    return {
      project: stack.project,
      service: stack.service,
      fileName: stack.fileName,
      content,
      revision: composeRevision(content),
    };
  }

  save(containerId: string, input: ComposeUpdateInput): Promise<ComposeSaveResponse> {
    const now = Date.now();
    for (const [key, value] of this.dedup) {
      if (value.settled && value.expires <= now) this.dedup.delete(key);
    }
    const opKey = `${containerId}:compose:${input.redeploy ? 'redeploy' : 'save'}`;
    const existing = this.dedup.get(input.requestId);
    if (existing) {
      if (existing.key !== opKey) {
        return Promise.reject(
          new AgentError(
            'REQUEST_ID_CONFLICT',
            'This request ID was already used for a different operation.',
            409,
          ),
        );
      }
      return existing.promise;
    }

    const maxEntries = this.options.maxEntries ?? 1024;
    while (this.dedup.size >= maxEntries) {
      const oldest = [...this.dedup].find(([, value]) => value.settled);
      if (!oldest) {
        return Promise.reject(
          new AgentError('ACTION_LIMIT_EXCEEDED', 'Too many operations are in progress.', 429),
        );
      }
      this.dedup.delete(oldest[0]);
    }

    const entry: ComposeDedupEntry = {
      key: opKey,
      expires: now + 600_000,
      settled: false,
      promise: Promise.resolve({
        ok: true,
        project: '',
        fileName: '',
        revision: '',
        redeployed: false,
      }),
    };
    entry.promise = this.executeSave(containerId, input).finally(() => {
      entry.settled = true;
      entry.expires = Date.now() + 600_000;
    });
    this.dedup.set(input.requestId, entry);
    return entry.promise;
  }

  private async executeSave(
    containerId: string,
    input: ComposeUpdateInput,
  ): Promise<ComposeSaveResponse> {
    const validation = validateComposeYaml(input.content);
    if (!validation.valid) {
      throw new AgentError(
        'INVALID_COMPOSE_YAML',
        validation.message || 'The Compose file contains invalid YAML.',
        400,
      );
    }

    const stack = await this.resolveStack(containerId);
    if (stack.service && !validation.services.includes(stack.service)) {
      throw new AgentError(
        'INVALID_COMPOSE_YAML',
        `The Compose file must retain service "${stack.service}" belonging to stack "${stack.project}".`,
        400,
      );
    }

    if (this.locked.has(stack.project)) {
      throw new AgentError(
        'ACTION_IN_PROGRESS',
        'Another Compose operation is already running for this stack.',
        409,
      );
    }

    this.locked.add(stack.project);
    const tempPath = `${stack.filePath}.${randomUUID()}.tmp`;
    try {
      let existingRaw: string;
      try {
        existingRaw = await readFile(stack.filePath, 'utf8');
      } catch {
        throw new AgentError(
          'COMPOSE_FILE_MISSING',
          'The Docker Compose file no longer exists on the host.',
          404,
        );
      }
      const existingContent = sanitizeComposeContent(existingRaw);
      const currentRev = composeRevision(existingContent);
      if (input.expectedRevision && input.expectedRevision !== currentRev) {
        throw new AgentError(
          'COMPOSE_CONFLICT',
          'The Compose file was modified on disk. Reload before saving.',
          409,
        );
      }

      const normalized = sanitizeComposeContent(input.content);
      const nextContent = normalized.endsWith('\n') ? normalized : `${normalized}\n`;

      const handle = await open(tempPath, 'wx', 0o600);
      try {
        await handle.writeFile(nextContent, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      await rename(tempPath, stack.filePath);
      if (process.platform !== 'win32') {
        const dirHandle = await open(stack.workingDir, 'r').catch(() => null);
        if (dirHandle) {
          try {
            await dirHandle.sync();
          } finally {
            await dirHandle.close();
          }
        }
      }

      const revision = composeRevision(nextContent);
      if (input.redeploy) {
        await this.runner({
          cwd: stack.workingDir,
          filePath: stack.filePath,
          project: stack.project,
          dockerSocket: this.options.dockerSocket,
        });
      }

      this.inventory.invalidate(containerId);
      this.options.onAuditLog?.({
        project: stack.project,
        containerId,
        fileName: stack.fileName,
        actor: input.actor || 'unknown',
        redeployed: input.redeploy,
        revision,
      });

      return {
        ok: true,
        project: stack.project,
        fileName: stack.fileName,
        revision,
        redeployed: input.redeploy,
      };
    } finally {
      await unlink(tempPath).catch(() => undefined);
      this.locked.delete(stack.project);
    }
  }
}
