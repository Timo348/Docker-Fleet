import { createHmac, timingSafeEqual } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../shared/types.js';
import { ApiError } from './errors.js';

export interface Identity {
  username: string;
  subject: string;
  development: boolean;
}
export class Authenticator {
  private readonly origin: string;
  constructor(
    private config: AppConfig,
    private secret: Buffer,
    private now = () => Date.now(),
  ) {
    if (secret.length < 32) throw new Error('auth.csrfSecretFile must contain at least 32 bytes.');
    this.origin = new URL(config.baseUrl).origin;
  }
  identity(request: FastifyRequest): Identity {
    if (this.config.auth.mode === 'development')
      return {
        username: this.config.auth.allowedUsers[0],
        subject: 'explicit-local-development',
        development: true,
      };
    const socket = request.raw.socket;
    if (!(socket instanceof TLSSocket) || !socket.authorized)
      throw new ApiError(401, 'UNTRUSTED_PROXY', 'A trusted authentication proxy is required.');
    const certificate = socket.getPeerCertificate();
    const commonName = certificate.subject?.CN;
    if (
      typeof commonName !== 'string' ||
      !this.config.server.tls?.allowedProxyNames.includes(commonName)
    )
      throw new ApiError(401, 'UNTRUSTED_PROXY', 'The proxy certificate identity is not allowed.');
    const username = request.headers[this.config.auth.usernameHeader.toLowerCase()];
    const subject = request.headers[this.config.auth.subjectHeader.toLowerCase()];
    if (
      typeof username !== 'string' ||
      typeof subject !== 'string' ||
      !/^[^\x00-\x1f\x7f,]{1,255}$/.test(username) ||
      !/^[^\x00-\x1f\x7f,]{1,255}$/.test(subject)
    )
      throw new ApiError(
        401,
        'IDENTITY_REQUIRED',
        'The authentication proxy did not supply a valid identity.',
      );
    if (!this.config.auth.allowedUsers.includes(username))
      throw new ApiError(
        403,
        'USER_FORBIDDEN',
        'This user is not allowed to administer Docker Fleet.',
      );
    return { username, subject, development: false };
  }
  token(identity: Identity): string {
    const expires = Math.floor(this.now() / 1000) + 1800;
    return `${expires}.${this.signature(identity, String(expires))}`;
  }
  private signature(identity: Identity, expires: string): string {
    return createHmac('sha256', this.secret)
      .update(`${identity.subject}\0${identity.username}\0${expires}`)
      .digest('base64url');
  }
  verifyMutation(request: FastifyRequest, identity: Identity): void {
    if (request.headers.origin !== this.origin)
      throw new ApiError(
        403,
        'ORIGIN_FORBIDDEN',
        'State changes require the configured application origin.',
      );
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || token.length > 128)
      throw new ApiError(
        403,
        'CSRF_REQUIRED',
        'A current CSRF token is required. Reload the application.',
      );
    const [expires, signature, extra] = token.split('.');
    const now = Math.floor(this.now() / 1000);
    if (
      extra ||
      !/^\d{10,11}$/.test(expires || '') ||
      Number(expires) <= now ||
      Number(expires) > now + 1800 ||
      !signature
    )
      throw new ApiError(
        403,
        'CSRF_INVALID',
        'The CSRF token expired or is invalid. Reload the application.',
      );
    const actual = Buffer.from(signature);
    const expected = Buffer.from(this.signature(identity, expires));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new ApiError(
        403,
        'CSRF_INVALID',
        'The CSRF token expired or is invalid. Reload the application.',
      );
  }
  verifyReadOrigin(request: FastifyRequest): void {
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    // Authentik redirects can be same-site navigations from another hostname. Permit
    // authenticated document navigation while keeping every API read same-origin.
    const navigation =
      request.method === 'GET' &&
      request.headers['sec-fetch-mode'] === 'navigate' &&
      request.headers['sec-fetch-dest'] === 'document' &&
      !request.url.startsWith('/api/');
    if (
      (origin !== undefined && origin !== this.origin) ||
      ((site === 'cross-site' || site === 'same-site') && !navigation)
    )
      throw new ApiError(403, 'ORIGIN_FORBIDDEN', 'Cross-origin requests are not allowed.');
  }
}
