import YAML from 'yaml';

export const MAX_COMPOSE_BYTES = 512 * 1024;
export const ALLOWED_COMPOSE_FILENAMES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
] as const;
export const COMPOSE_PROJECT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
export const COMPOSE_SERVICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export interface ComposeValidationIssue {
  message: string;
  line?: number;
  column?: number;
}

export interface ComposeValidationResult {
  valid: boolean;
  errors: ComposeValidationIssue[];
  message?: string;
  services: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isValidComposeProjectName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    COMPOSE_PROJECT_PATTERN.test(value) &&
    !value.includes('..') &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

export function sanitizeComposeContent(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function validateComposeYaml(raw: unknown): ComposeValidationResult {
  if (typeof raw !== 'string') {
    const message = 'Compose content must be a string.';
    return { valid: false, errors: [{ message }], message, services: [] };
  }
  if (raw.includes('\0')) {
    const message = 'Compose content must not contain null bytes.';
    return { valid: false, errors: [{ message }], message, services: [] };
  }
  const content = sanitizeComposeContent(raw);
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > MAX_COMPOSE_BYTES) {
    const message = 'Compose file exceeds the maximum allowed size of 512 KiB.';
    return { valid: false, errors: [{ message }], message, services: [] };
  }
  if (!content.trim()) {
    const message = 'Compose file must not be empty.';
    return { valid: false, errors: [{ message }], message, services: [] };
  }

  const doc = YAML.parseDocument(content, {
    uniqueKeys: true,
    maxAliasCount: 50,
    prettyErrors: true,
  } as Parameters<typeof YAML.parseDocument>[1]);

  if (doc.errors.length > 0) {
    const errors: ComposeValidationIssue[] = doc.errors.map((err) => {
      const pos = err.linePos?.[0];
      const headline = err.message.split('\n')[0]?.trim() || 'Invalid YAML syntax.';
      return {
        message: pos ? `Line ${pos.line}, column ${pos.col}: ${headline}` : headline,
        ...(pos ? { line: pos.line, column: pos.col } : {}),
      };
    });
    const message = `Invalid YAML: ${errors[0]!.message}`;
    return { valid: false, errors, message, services: [] };
  }

  let parsed: unknown;
  try {
    parsed = doc.toJS({ maxAliasCount: 50 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unable to resolve YAML document.';
    const message = `Invalid YAML: ${detail}`;
    return { valid: false, errors: [{ message }], message, services: [] };
  }

  if (!isPlainObject(parsed)) {
    const message = 'Compose root document must be a YAML mapping.';
    return { valid: false, errors: [{ message }], message, services: [] };
  }

  const errors: ComposeValidationIssue[] = [];

  if (parsed.name !== undefined && !isValidComposeProjectName(parsed.name)) {
    errors.push({
      message: 'Top-level "name" must be a valid Compose project identifier.',
    });
  }

  if (!isPlainObject(parsed.services)) {
    errors.push({
      message: 'Compose file must define a "services" mapping.',
    });
  } else {
    const serviceEntries = Object.entries(parsed.services);
    if (serviceEntries.length === 0) {
      errors.push({
        message: 'Compose file must define at least one service under "services".',
      });
    }
    for (const [serviceName, serviceConfig] of serviceEntries) {
      if (!COMPOSE_SERVICE_PATTERN.test(serviceName) || serviceName.includes('..')) {
        errors.push({
          message: `Service "${serviceName}": invalid service name.`,
        });
        continue;
      }
      if (!isPlainObject(serviceConfig)) {
        errors.push({
          message: `Service "${serviceName}": definition must be a mapping.`,
        });
        continue;
      }
      if (
        serviceConfig.image !== undefined &&
        (typeof serviceConfig.image !== 'string' ||
          !serviceConfig.image.trim() ||
          /[\x00-\x1f\x7f]/.test(serviceConfig.image))
      ) {
        errors.push({
          message: `Service "${serviceName}": "image" must be a non-empty string.`,
        });
      }
      if (
        serviceConfig.build !== undefined &&
        typeof serviceConfig.build !== 'string' &&
        !isPlainObject(serviceConfig.build)
      ) {
        errors.push({
          message: `Service "${serviceName}": "build" must be a string path or mapping.`,
        });
      }
      if (serviceConfig.ports !== undefined && !Array.isArray(serviceConfig.ports)) {
        errors.push({
          message: `Service "${serviceName}": "ports" must be a list.`,
        });
      }
      if (serviceConfig.volumes !== undefined && !Array.isArray(serviceConfig.volumes)) {
        errors.push({
          message: `Service "${serviceName}": "volumes" must be a list.`,
        });
      }
      if (
        serviceConfig.environment !== undefined &&
        !Array.isArray(serviceConfig.environment) &&
        !isPlainObject(serviceConfig.environment)
      ) {
        errors.push({
          message: `Service "${serviceName}": "environment" must be a mapping or list.`,
        });
      }
      if (
        serviceConfig.depends_on !== undefined &&
        !Array.isArray(serviceConfig.depends_on) &&
        !isPlainObject(serviceConfig.depends_on)
      ) {
        errors.push({
          message: `Service "${serviceName}": "depends_on" must be a mapping or list.`,
        });
      }
      if (
        serviceConfig.networks !== undefined &&
        !Array.isArray(serviceConfig.networks) &&
        !isPlainObject(serviceConfig.networks)
      ) {
        errors.push({
          message: `Service "${serviceName}": "networks" must be a mapping or list.`,
        });
      }
    }
  }

  for (const section of ['volumes', 'networks', 'configs', 'secrets'] as const) {
    if (
      parsed[section] !== undefined &&
      parsed[section] !== null &&
      !isPlainObject(parsed[section])
    ) {
      errors.push({
        message: `Top-level "${section}" must be a mapping.`,
      });
    }
  }

  if (errors.length > 0) {
    return {
      valid: false,
      errors,
      message: errors.map((e) => e.message).join(' '),
      services: [],
    };
  }

  return {
    valid: true,
    errors: [],
    services: Object.keys(parsed.services as Record<string, unknown>),
  };
}
