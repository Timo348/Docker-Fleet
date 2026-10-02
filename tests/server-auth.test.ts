import { describe, expect, it } from 'vitest';
import { TLSSocket } from 'node:tls';
import { Socket } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { Authenticator } from '../src/server/auth.js';
import type { AppConfig } from '../src/shared/types.js';

function config(): AppConfig {
  return {
    auth: {
      mode: 'proxy',
      usernameHeader: 'X-User',
      subjectHeader: 'X-Subject',
      allowedUsers: ['test-user'],
      csrfSecretFile: '/secret',
    },
    server: {
      host: '127.0.0.1',
      port: 8080,
      tls: {
        certFile: '/cert',
        keyFile: '/key',
        proxyCaFile: '/ca',
        allowedProxyNames: ['caddy-fleet'],
      },
    },
    baseUrl: 'https://fleet.example.org',
  } as AppConfig;
}
function request(socket: Socket, headers: Record<string, string>): FastifyRequest {
  return { raw: { socket }, headers } as unknown as FastifyRequest;
}
describe('proxy trust boundary', () => {
  it('ignores spoofed identity headers on untrusted and unverified connections', () => {
    const auth = new Authenticator(config(), Buffer.alloc(32, 1));
    const headers = { 'x-user': 'test-user', 'x-subject': 'uid' };
    const plain = new Socket();
    const tls = new TLSSocket(new Socket());
    expect(() => auth.identity(request(plain, headers))).toThrow(/trusted authentication proxy/);
    expect(() => auth.identity(request(tls, headers))).toThrow(/trusted authentication proxy/);
    plain.destroy();
    tls.destroy();
  });
  it('checks both authenticated proxy certificate name and allowed end user', () => {
    const auth = new Authenticator(config(), Buffer.alloc(32, 1));
    const tls = new TLSSocket(new Socket());
    tls.authorized = true;
    tls.getPeerCertificate = (() => ({
      subject: { CN: 'other-proxy' },
    })) as typeof tls.getPeerCertificate;
    expect(() =>
      auth.identity(request(tls, { 'x-user': 'test-user', 'x-subject': 'uid' })),
    ).toThrow(/certificate identity/);
    tls.getPeerCertificate = (() => ({
      subject: { CN: 'caddy-fleet' },
    })) as typeof tls.getPeerCertificate;
    expect(() => auth.identity(request(tls, { 'x-user': 'someone', 'x-subject': 'uid' }))).toThrow(
      /not allowed/,
    );
    expect(() => auth.identity(request(tls, { 'x-user': 'test-user' }))).toThrow(/valid identity/);
    expect(auth.identity(request(tls, { 'x-user': 'test-user', 'x-subject': 'uid' }))).toEqual({
      username: 'test-user',
      subject: 'uid',
      development: false,
    });
    tls.destroy();
  });
  it('binds CSRF tokens to the confirmed subject and expires them', () => {
    let now = Date.UTC(2026, 9, 2);
    const auth = new Authenticator(config(), Buffer.alloc(32, 1), () => now);
    const user = { username: 'test-user', subject: 'uid', development: false };
    const token = auth.token(user);
    const socket = new Socket();
    const req = request(socket, { origin: 'https://fleet.example.org', 'x-csrf-token': token });
    expect(() => auth.verifyMutation(req, user)).not.toThrow();
    expect(() => auth.verifyMutation(req, { ...user, subject: 'different-uid' })).toThrow(
      /invalid/,
    );
    now += 1800001;
    expect(() => auth.verifyMutation(req, user)).toThrow(/expired/);
    socket.destroy();
    expect(() => new Authenticator(config(), Buffer.alloc(31))).toThrow(/at least 32 bytes/);
  });
  it('permits Authentik document redirects while rejecting same-site API fetches', () => {
    const auth = new Authenticator(config(), Buffer.alloc(32, 1));
    const socket = new Socket();
    const navigation = {
      ...request(socket, {
        'sec-fetch-site': 'same-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      }),
      method: 'GET',
      url: '/',
    } as FastifyRequest;
    expect(() => auth.verifyReadOrigin(navigation)).not.toThrow();
    expect(() =>
      auth.verifyReadOrigin({ ...navigation, url: '/api/resources' } as FastifyRequest),
    ).toThrow(/Cross-origin/);
    socket.destroy();
  });
});
