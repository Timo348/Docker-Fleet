import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { ConfigStore, parseConfig, validateConfig } from '../src/server/config.js';
import { fixture } from './server-fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(extension?: string) {
  const result = await fixture(extension);
  cleanups.push(result.cleanup);
  return result;
}

describe('configuration security and persistence', () => {
  it('fails closed unless development is explicitly allowed on loopback', async () => {
    const { config } = await setup();
    expect(() => validateConfig(config, false)).toThrow(/development requires/);
    expect(() =>
      validateConfig({ ...config, server: { host: '0.0.0.0', port: 8080 } }, true),
    ).toThrow(/loopback/);
    expect(() =>
      validateConfig(
        {
          ...config,
          auth: { ...config.auth, mode: 'proxy' },
          baseUrl: 'https://fleet.example.org',
        },
        true,
      ),
    ).toThrow(/server.tls/);
  });
  it('rejects unknown fields, duplicate hosts, insecure endpoints and unknown credential references', async () => {
    const { config } = await setup();
    expect(() => validateConfig({ ...config, surprise: true }, true)).toThrow(/surprise/);
    expect(() =>
      validateConfig({ ...config, hosts: [config.hosts[0], config.hosts[0]] }, true),
    ).toThrow(/duplicate host ID/);
    for (const agentUrl of [
      'http://agent:9443',
      'https://secret:password@agent:9443',
      'https://agent:9443/docker',
      'https://agent:9443/?target=x',
    ])
      expect(() =>
        validateConfig({ ...config, hosts: [{ ...config.hosts[0], agentUrl }] }, true),
      ).toThrow(/agentUrl/);
    expect(() =>
      validateConfig(
        { ...config, hosts: [{ ...config.hosts[0], credentialRef: 'missing' }] },
        true,
      ),
    ).toThrow(/credentialRef/);
  });
  it('reads equivalent YAML and JSON and rejects duplicate keys and aliases', async () => {
    const { config } = await setup();
    expect(parseConfig(YAML.stringify(config), 'config.yml', true)).toEqual(
      parseConfig(JSON.stringify(config), 'config.json', true),
    );
    expect(() => parseConfig('version: 1\nversion: 1\n', 'config.yml', true)).toThrow(
      /parsing failed/,
    );
    expect(() => parseConfig('version: &value 1\nserver: *value\n', 'config.yml', true)).toThrow();
  });
  it('keeps secrets private and preserves the complete authoritative file on UI updates', async () => {
    const { config, configFile } = await setup('.yml');
    const store = await ConfigStore.load(configFile, true);
    const publicConfig = store.publicConfig();
    expect(JSON.stringify(publicConfig)).not.toContain('csrf.secret');
    expect(JSON.stringify(publicConfig)).not.toContain('/secrets/');
    const next = await store.update(
      {
        hosts: [{ ...config.hosts[0], name: 'Changed' }],
        polling: config.polling,
        logs: config.logs,
      },
      publicConfig.revision,
    );
    expect(next.hosts[0].name).toBe('Changed');
    expect(next.revision).not.toBe(publicConfig.revision);
    const disk = parseConfig(await readFile(configFile, 'utf8'), configFile, true);
    expect(disk.credentials).toEqual(config.credentials);
    expect(disk.auth).toEqual(config.auth);
    expect(disk.storage).toEqual(config.storage);
  });
  it('serializes simultaneous edits and rejects a stale ETag without overwriting the winner', async () => {
    const { config, configFile } = await setup();
    const store = await ConfigStore.load(configFile, true);
    const revision = store.publicConfig().revision;
    const payload = { hosts: config.hosts, polling: config.polling, logs: config.logs };
    const results = await Promise.allSettled([
      store.update({ ...payload, hosts: [{ ...config.hosts[0], name: 'First' }] }, revision),
      store.update({ ...payload, hosts: [{ ...config.hosts[0], name: 'Second' }] }, revision),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(store.publicConfig().hosts[0].name).toBe('First');
  });
  it('detects manual edits, external locks and invalid reloads while retaining the last valid configuration', async () => {
    const { config, configFile } = await setup();
    const store = await ConfigStore.load(configFile, true);
    const revision = store.publicConfig().revision;
    await writeFile(
      configFile,
      JSON.stringify({ ...config, hosts: [{ ...config.hosts[0], name: 'Manual edit' }] }),
    );
    await expect(
      store.update({ hosts: config.hosts, polling: config.polling, logs: config.logs }, revision),
    ).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
    expect((await store.reload()).hosts[0].name).toBe('Manual edit');
    await writeFile(`${configFile}.lock`, 'manual editor');
    await expect(
      store.update(
        { hosts: config.hosts, polling: config.polling, logs: config.logs },
        store.publicConfig().revision,
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_LOCKED' });
    await writeFile(configFile, '{broken');
    await expect(store.reload()).rejects.toThrow();
    expect(store.publicConfig().hosts[0].name).toBe('Manual edit');
  });
  it('requires a restart for changes to credentials and authentication', async () => {
    const { config, configFile } = await setup();
    const store = await ConfigStore.load(configFile, true);
    await writeFile(
      configFile,
      JSON.stringify({ ...config, auth: { ...config.auth, allowedUsers: ['someone'] } }),
    );
    await expect(store.reload()).rejects.toMatchObject({ code: 'RESTART_REQUIRED' });
    expect(store.current.auth.allowedUsers).toEqual(['test-user']);
  });
});
