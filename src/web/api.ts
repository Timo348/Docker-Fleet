import type {
  ComposeFileResponse,
  ComposeSaveResponse,
  PublicConfig,
  Resources,
} from '../shared/types.js';
export interface Session {
  user: string;
  csrfToken: string;
  development: boolean;
}
let token = '';
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== 'GET') {
    headers.set('X-CSRF-Token', token);
    headers.set('Content-Type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    throw new Error(
      'The application could not be reached. Your authentication may have expired; reload to sign in.',
    );
  }
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error(
      'Authentication expired or the proxy returned an unexpected response. Reload to sign in.',
    );
  const body = await response.json().catch(() => {
    throw new Error('The application returned an invalid response. Try reloading.');
  });
  if (!response.ok) throw new Error(body.message || `Request failed (${response.status})`);
  return body as T;
}
export async function session() {
  const value = await api<Session>('/session');
  if (
    typeof value.user !== 'string' ||
    typeof value.csrfToken !== 'string' ||
    typeof value.development !== 'boolean'
  )
    throw new Error('The authentication response is invalid. Reload to sign in.');
  token = value.csrfToken;
  return value;
}
export const resources = async () => {
  const value = await api<Resources>('/resources');
  if (![value.hosts, value.containers, value.images, value.volumes].every(Array.isArray))
    throw new Error('The application returned invalid resource data.');
  return value;
};
export const configuration = async () => {
  const value = await api<PublicConfig>('/config');
  if (
    !value ||
    !Array.isArray(value.hosts) ||
    !Array.isArray(value.credentialRefs) ||
    !value.polling ||
    !value.logs ||
    typeof value.revision !== 'string'
  )
    throw new Error('The application returned invalid configuration data.');
  return value;
};
export const getCompose = async (hostId: string, containerId: string) => {
  const value = await api<ComposeFileResponse>(
    `/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/compose`,
  );
  if (
    !value ||
    typeof value.project !== 'string' ||
    typeof value.fileName !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.revision !== 'string'
  )
    throw new Error('The application returned invalid Compose file data.');
  return value;
};
export const saveCompose = async (
  hostId: string,
  containerId: string,
  payload: {
    requestId: string;
    content: string;
    redeploy: boolean;
    expectedRevision?: string;
  },
) => {
  const value = await api<ComposeSaveResponse>(
    `/hosts/${encodeURIComponent(hostId)}/containers/${encodeURIComponent(containerId)}/compose`,
    {
      method: 'PUT',
      headers: payload.expectedRevision ? { 'If-Match': payload.expectedRevision } : {},
      body: JSON.stringify(payload),
    },
  );
  if (!value || value.ok !== true || typeof value.revision !== 'string')
    throw new Error('The application returned an invalid Compose save response.');
  return value;
};
