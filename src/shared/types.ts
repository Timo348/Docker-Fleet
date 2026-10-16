export type Action = 'start' | 'stop' | 'restart';
export type AuditAction = Action | 'compose-save' | 'compose-redeploy';
export interface HostConfig {
  id: string;
  name: string;
  agentUrl: string;
  enabled: boolean;
  credentialRef: string;
  timeoutMs: number;
}
export interface Credential {
  caFile: string;
  certFile: string;
  keyFile: string;
  serverName?: string;
}
export interface AppConfig {
  version: 1;
  server: {
    host: string;
    port: number;
    tls?: { certFile: string; keyFile: string; proxyCaFile: string; allowedProxyNames: string[] };
  };
  baseUrl: string;
  auth: {
    mode: 'proxy' | 'development';
    usernameHeader: string;
    subjectHeader: string;
    allowedUsers: string[];
    csrfSecretFile: string;
  };
  credentials: Record<string, Credential>;
  hosts: HostConfig[];
  polling: { inventoryMs: number; statsMs: number };
  logs: {
    defaultTail: number;
    maxTail: number;
    maxBufferBytes: number;
    maxLineBytes: number;
    maxStreamsPerUser: number;
    maxStreamsTotal: number;
    maxStreamSeconds: number;
  };
  storage: { dataDir: string; auditMaxBytes: number };
}
export interface Container {
  id: string;
  hostId?: string;
  name: string;
  image: string;
  imageId: string;
  state: string;
  status: string;
  health: string | null;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  ports: { ip: string; privatePort: number; publicPort?: number; type: string }[];
  composeProject: string | null;
  composeService: string | null;
  startedAt: string | null;
}
export interface Image {
  id: string;
  hostId?: string;
  tags: string[];
  sizeBytes: number;
  createdAt: string;
  containerIds: string[];
}
export interface Volume {
  id: string;
  hostId?: string;
  name: string;
  driver: string;
  scope: string;
  containerIds: string[];
  composeProject: string | null;
  sizeBytes: null;
}
export interface Stats {
  id: string;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
}
export interface Snapshot {
  containers: Container[];
  images: Image[];
  volumes: Volume[];
  collectedAt: string;
  engineVersion: string;
}
export interface HostStatus {
  id: string;
  name: string;
  enabled: boolean;
  state: 'online' | 'offline' | 'connecting' | 'disabled';
  lastSuccess: string | null;
  error: string | null;
  stale: boolean;
  engineVersion?: string;
}
export interface Resources {
  containers: Container[];
  images: Image[];
  volumes: Volume[];
  hosts: HostStatus[];
}
export interface LogLine {
  stream: 'stdout' | 'stderr' | 'console';
  text: string;
  timestamp?: string;
  truncated?: boolean;
}
export interface PublicConfig {
  version: 1;
  hosts: HostConfig[];
  credentialRefs: string[];
  polling: AppConfig['polling'];
  logs: AppConfig['logs'];
  baseUrl: string;
  auth: { mode: string };
  revision: string;
}
export interface ComposeFileResponse {
  project: string;
  service: string | null;
  fileName: string;
  content: string;
  revision: string;
}
export interface ComposeSaveRequest {
  requestId: string;
  content: string;
  redeploy: boolean;
  expectedRevision?: string;
}
export interface ComposeSaveResponse {
  ok: true;
  project: string;
  fileName: string;
  revision: string;
  redeployed: boolean;
}
