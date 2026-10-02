import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Boxes,
  Container as ContainerIcon,
  Layers,
  HardDrive,
  Server,
  RefreshCw,
  Search,
  Play,
  Square,
  RotateCw,
  ScrollText,
  X,
  Plus,
  Check,
  Copy,
  Download,
  Pause,
  ChevronDown,
  ArrowUpDown,
  CircleAlert,
  Settings2,
  ExternalLink,
} from 'lucide-react';
import type {
  Action,
  Container,
  HostConfig,
  HostStatus,
  Image,
  LogLine,
  PublicConfig,
  Resources,
  Volume,
} from '../shared/types.js';
import { api, configuration, resources, session, type Session } from './api.js';
import './style.css';

type Tab = 'containers' | 'images' | 'volumes' | 'hosts';
const empty: Resources = { containers: [], images: [], volumes: [], hosts: [] };
const tabs = [
  { id: 'containers', name: 'Containers', icon: ContainerIcon },
  { id: 'images', name: 'Images', icon: Layers },
  { id: 'volumes', name: 'Volumes', icon: HardDrive },
  { id: 'hosts', name: 'Hosts & settings', icon: Server },
] as const;
function bytes(value: number | null | undefined) {
  if (value == null) return '—';
  if (!value) return '0 B';
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** i).toFixed(i ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][i]}`;
}
function date(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : 'Never';
}
function duration(value: string | null) {
  if (!value) return '—';
  const sec = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  return sec > 86400
    ? `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`
    : sec > 3600
      ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
      : `${Math.floor(sec / 60)}m`;
}
function key(row: { id: string; hostId?: string }) {
  return `${row.hostId}:${row.id}`;
}
function Badge({ state, text }: { state: string; text?: string }) {
  return (
    <span className={`badge ${state}`}>
      <span className="dot" />
      {text || state}
    </span>
  );
}

function App() {
  const [identity, setIdentity] = useState<Session | null>(null);
  const [data, setData] = useState<Resources>(empty);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [tab, setTab] = useState<Tab>('containers');
  const [host, setHost] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [desc, setDesc] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<Record<string, Action>>({});
  const [logTarget, setLogTarget] = useState<Container | null>(null);
  const [editHost, setEditHost] = useState<HostConfig | 'new' | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [next, conf] = await Promise.all([resources(), configuration()]);
    setData(next);
    setConfig(conf);
  }, []);
  useEffect(() => {
    let alive = true;
    session()
      .then((s) => {
        if (alive) {
          setIdentity(s);
          return load();
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      alive = false;
    };
  }, [load]);
  useEffect(() => {
    if (!identity) return;
    const timer = setInterval(
      () =>
        resources()
          .then(setData)
          .catch((e) => setError(e.message)),
      3000,
    );
    const renew = setInterval(
      () =>
        session()
          .then(setIdentity)
          .catch((e) => setError(e.message)),
      10 * 60_000,
    );
    return () => {
      clearInterval(timer);
      clearInterval(renew);
    };
  }, [identity?.user]);
  useEffect(() => {
    setSort('name');
    setDesc(false);
  }, [tab]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.key === '/' &&
        !['INPUT', 'SELECT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName) &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('input[aria-label="Search resources"]')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  const hostMap = useMemo(() => new Map(data.hosts.map((h) => [h.id, h])), [data.hosts]);
  const hostName = (id?: string) => hostMap.get(id || '')?.name || id || 'Unknown';
  const sortBy = (field: string) => {
    if (sort === field) setDesc(!desc);
    else {
      setSort(field);
      setDesc(false);
    }
  };
  const values = useMemo(() => {
    const rows =
      tab === 'containers' ? data.containers : tab === 'images' ? data.images : data.volumes;
    const needle = query.toLowerCase();
    return rows
      .filter(
        (r) =>
          (host === 'all' || r.hostId === host) &&
          JSON.stringify([r, hostMap.get(r.hostId || '')?.name])
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) => {
        const field = (r: Container | Image | Volume): string | number =>
          sort === 'host'
            ? hostMap.get(r.hostId || '')?.name || ''
            : sort === 'size'
              ? 'sizeBytes' in r
                ? r.sizeBytes || 0
                : 'memoryBytes' in r
                  ? r.memoryBytes || 0
                  : 0
              : sort === 'state'
                ? 'state' in r
                  ? r.state
                  : ''
                : sort === 'cpu'
                  ? 'cpuPercent' in r
                    ? (r.cpuPercent ?? -1)
                    : -1
                  : 'name' in r
                    ? r.name
                    : r.tags[0] || r.id;
        const x = field(a),
          y = field(b);
        const compare =
          typeof x === 'number' && typeof y === 'number'
            ? x - y
            : String(x).localeCompare(String(y));
        return compare * (desc ? -1 : 1);
      });
  }, [tab, data, host, query, sort, desc, hostMap]);
  const refresh = async () => {
    setRefreshing(true);
    setError('');
    try {
      await api('/refresh', { method: 'POST', body: '{}' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const action = async (row: Container, act: Action) => {
    const resourceKey = key(row);
    if (busy[resourceKey]) return;
    setBusy((old) => ({ ...old, [resourceKey]: act }));
    setError('');
    setNotice(
      `${act === 'stop' ? 'Stopping' : act === 'start' ? 'Starting' : 'Restarting'} ${row.name} on ${hostName(row.hostId)}…`,
    );
    try {
      await api(`/hosts/${encodeURIComponent(row.hostId!)}/containers/${row.id}/${act}`, {
        method: 'POST',
        body: JSON.stringify({ requestId: crypto.randomUUID() }),
      });
      setNotice(`${row.name} on ${hostName(row.hostId)}: ${act} completed.`);
      await load();
    } catch (e) {
      setError(`${row.name} on ${hostName(row.hostId)}: ${(e as Error).message}`);
      await resources()
        .then(setData)
        .catch(() => {});
    } finally {
      setBusy((old) => {
        const next = { ...old };
        delete next[resourceKey];
        return next;
      });
    }
  };
  const saveHosts = async (hosts: HostConfig[]) => {
    if (!config) return;
    const next = await api<PublicConfig>('/config', {
      method: 'PUT',
      headers: { 'If-Match': config.revision },
      body: JSON.stringify({ hosts, polling: config.polling, logs: config.logs }),
    });
    setConfig(next);
    setEditHost(null);
    setNotice('Configuration saved. Host changes are active.');
    await resources().then(setData);
  };
  const test = async (id: string) => {
    setTesting(id);
    setError('');
    try {
      const result = await api<{ ok: boolean; message: string }>(
        `/hosts/${encodeURIComponent(id)}/test`,
        { method: 'POST', body: '{}' },
      );
      if (!result.ok) setError(result.message);
      else setNotice(result.message || 'Agent connection verified.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(null);
    }
  };
  const heading = (field: string, label: string) => (
    <button className="sort" onClick={() => sortBy(field)}>
      {label}
      <ArrowUpDown size={11} className={sort === field ? 'selected' : ''} />
    </button>
  );
  const sortHeading = (field: string, label: string) => (
    <th aria-sort={sort === field ? (desc ? 'descending' : 'ascending') : 'none'}>
      {heading(field, label)}
    </th>
  );
  if (!identity)
    return (
      <main className="access">
        <Boxes size={32} />
        <h1>Docker Fleet</h1>
        <p>{error || 'Verifying access…'}</p>
        {error && <button onClick={() => location.reload()}>Retry connection</button>}
      </main>
    );
  return (
    <div className="app">
      <header className="topbar">
        <a
          href="#"
          className="brand"
          aria-label="Docker Fleet containers"
          onClick={() => setTab('containers')}
        >
          <Boxes size={23} />
          <span>
            Docker <strong>Fleet</strong>
          </span>
        </a>
        <nav aria-label="Main navigation">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => {
                setTab(t.id);
                setLogTarget(null);
              }}
              aria-current={tab === t.id ? 'page' : undefined}
            >
              <t.icon size={15} />
              {t.name}
            </button>
          ))}
        </nav>
        <span className="identity">
          {identity.development && <span className="dev-label">LOCAL DEV</span>}
          {identity.user}
        </span>
      </header>
      <main>
        <div className="page-heading">
          <h1>{tabs.find((t) => t.id === tab)?.name}</h1>
          <button className="refresh" onClick={refresh} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'working' : ''} />
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
        <div className="host-strip" aria-label="Host connection status">
          {data.hosts.map((h) => (
            <div
              key={h.id}
              className="host-state"
              title={`${h.error || h.state}\nLast successful update: ${date(h.lastSuccess)}`}
            >
              <span className={`dot ${h.state}`} />
              <strong>{h.name}</strong>
              <span>{h.stale && h.lastSuccess ? 'Stale' : h.state}</span>
              <time>
                {h.lastSuccess ? new Date(h.lastSuccess).toLocaleTimeString() : 'No data yet'}
              </time>
            </div>
          ))}
          {!data.hosts.length && <span>No hosts configured</span>}
        </div>
        {error && (
          <div className="message error" role="alert">
            <CircleAlert size={15} />
            <span>{error}</span>
            <button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error">
              <X size={14} />
            </button>
          </div>
        )}
        {notice && (
          <div className="message notice" role="status">
            <Check size={14} />
            <span>{notice}</span>
            <button
              className="icon-button"
              onClick={() => setNotice('')}
              aria-label="Dismiss notice"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {data.hosts
          .filter((h) => h.enabled && h.error)
          .map((h) => (
            <div className="host-error" key={h.id}>
              <CircleAlert size={13} />
              <strong>{h.name}</strong>
              {h.error}
              {h.lastSuccess && <span>Showing data from {date(h.lastSuccess)}</span>}
            </div>
          ))}
        {tab !== 'hosts' ? (
          <>
            <div className="toolbar">
              <label className="host-filter">
                <Server size={14} />
                <select
                  aria-label="Filter by host"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                >
                  <option value="all">All hosts</option>
                  {data.hosts
                    .filter((h) => h.enabled)
                    .map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                </select>
                <ChevronDown size={12} />
              </label>
              <label className="search">
                <Search size={15} />
                <input
                  aria-label="Search resources"
                  placeholder={`Search ${tab}…`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <kbd>/</kbd>
              </label>
              <span className="row-count">
                {values.length} {tab}
              </span>
            </div>
            <div
              className="table-scroll"
              tabIndex={0}
              aria-label={`${tab} table, scroll horizontally for more columns`}
            >
              <table>
                <thead>
                  {tab === 'containers' ? (
                    <tr>
                      {sortHeading('name', 'Name / compose')}
                      {sortHeading('host', 'Host')}
                      <th>Image</th>
                      {sortHeading('state', 'State / health')}
                      {sortHeading('cpu', 'CPU')}
                      {sortHeading('size', 'Memory / limit')}
                      <th>Ports</th>
                      <th>Uptime</th>
                      <th className="actions-head">Actions</th>
                    </tr>
                  ) : tab === 'images' ? (
                    <tr>
                      {sortHeading('name', 'Repository / tags')}
                      {sortHeading('host', 'Host')}
                      <th>Image ID</th>
                      {sortHeading('size', 'Size')}
                      <th>Created</th>
                      <th>Used by</th>
                    </tr>
                  ) : (
                    <tr>
                      {sortHeading('name', 'Name')}
                      {sortHeading('host', 'Host')}
                      <th>Driver</th>
                      <th>Scope</th>
                      <th>Compose project</th>
                      <th>Used by</th>
                      <th>Size</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {values.map((r) => {
                    const status = hostMap.get(r.hostId!);
                    const stale = !!status?.stale;
                    const hostCell = (
                      <td>
                        <span className="host-tag">{hostName(r.hostId)}</span>
                        {stale && <small className="stale-text">Stale</small>}
                      </td>
                    );
                    if (tab === 'containers') {
                      const row = r as Container;
                      const op = busy[key(row)];
                      const running = row.state === 'running';
                      const disabled = !!op || status?.state !== 'online' || stale;
                      return (
                        <tr key={key(row)} className={stale ? 'stale-row' : ''}>
                          <td>
                            <strong className="resource-name">{row.name}</strong>
                            <small>
                              {row.composeProject
                                ? `${row.composeProject} / ${row.composeService || '—'}`
                                : row.id.slice(0, 12)}
                            </small>
                          </td>
                          {hostCell}
                          <td className="image-cell" title={row.image}>
                            {row.image}
                          </td>
                          <td>
                            <Badge state={row.state} />
                            <small>
                              {row.health ? (
                                <span className={`health ${row.health}`}>{row.health}</span>
                              ) : (
                                'No healthcheck'
                              )}
                            </small>
                          </td>
                          <td className="numeric">
                            {row.cpuPercent == null ? '—' : `${row.cpuPercent.toFixed(1)}%`}
                          </td>
                          <td className="numeric">
                            <span>{bytes(row.memoryBytes)}</span>
                            <small>
                              {row.memoryLimitBytes
                                ? `/ ${bytes(row.memoryLimitBytes)}`
                                : 'Limit unavailable'}
                            </small>
                          </td>
                          <td className="ports">
                            {row.ports.length ? (
                              row.ports.map((p, i) => (
                                <span key={i}>
                                  {p.publicPort ? `${p.ip || '*'}:${p.publicPort} → ` : ''}
                                  {p.privatePort}/{p.type}
                                </span>
                              ))
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td title={date(row.startedAt)}>
                            {running ? duration(row.startedAt) : '—'}
                          </td>
                          <td className="row-actions">
                            {op ? (
                              <span className="operation">
                                <RefreshCw size={13} className="working" />
                                {op}…
                              </span>
                            ) : (
                              <>
                                {running ? (
                                  <button
                                    className="icon-button"
                                    title={`Stop ${row.name} on ${hostName(row.hostId)}`}
                                    aria-label={`Stop ${row.name} on ${hostName(row.hostId)}`}
                                    disabled={disabled}
                                    onClick={() => action(row, 'stop')}
                                  >
                                    <Square size={14} />
                                  </button>
                                ) : (
                                  <button
                                    className="icon-button"
                                    title={`Start ${row.name} on ${hostName(row.hostId)}`}
                                    aria-label={`Start ${row.name} on ${hostName(row.hostId)}`}
                                    disabled={
                                      disabled || !['exited', 'created'].includes(row.state)
                                    }
                                    onClick={() => action(row, 'start')}
                                  >
                                    <Play size={15} />
                                  </button>
                                )}
                                <button
                                  className="icon-button"
                                  title={`Restart ${row.name} on ${hostName(row.hostId)}`}
                                  aria-label={`Restart ${row.name} on ${hostName(row.hostId)}`}
                                  disabled={disabled || !running}
                                  onClick={() => action(row, 'restart')}
                                >
                                  <RotateCw size={15} />
                                </button>
                              </>
                            )}
                            <button
                              className="icon-button"
                              title={`Logs for ${row.name} on ${hostName(row.hostId)}`}
                              aria-label={`Logs for ${row.name} on ${hostName(row.hostId)}`}
                              disabled={status?.state !== 'online'}
                              onClick={() => setLogTarget(row)}
                            >
                              <ScrollText size={15} />
                            </button>
                          </td>
                        </tr>
                      );
                    }
                    if (tab === 'images') {
                      const row = r as Image;
                      return (
                        <tr key={key(row)}>
                          <td>
                            <strong className="resource-name">{row.tags[0] || '<untagged>'}</strong>
                            <small>{row.tags.slice(1).join(', ') || '—'}</small>
                          </td>
                          {hostCell}
                          <td className="mono" title={row.id}>
                            {row.id.replace('sha256:', '').slice(0, 12)}
                          </td>
                          <td className="numeric">{bytes(row.sizeBytes)}</td>
                          <td>{date(row.createdAt)}</td>
                          <td>{containerNames(row.hostId, row.containerIds, data.containers)}</td>
                        </tr>
                      );
                    }
                    const row = r as Volume;
                    return (
                      <tr key={key(row)}>
                        <td>
                          <strong className="resource-name">{row.name}</strong>
                        </td>
                        {hostCell}
                        <td>{row.driver}</td>
                        <td>{row.scope}</td>
                        <td>{row.composeProject || '—'}</td>
                        <td>{containerNames(row.hostId, row.containerIds, data.containers)}</td>
                        <td className="muted">Unavailable</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!values.length && (
                <div className="empty-state">
                  <Boxes size={27} />
                  <h2>{query ? 'No matching resources' : `No ${tab} to display`}</h2>
                  <p>
                    {query
                      ? 'Try another search or host filter.'
                      : data.hosts.some((h) => h.state === 'online')
                        ? 'The connected hosts have no resources in this view.'
                        : 'Connect an agent in Hosts & settings to load real Docker data.'}
                  </p>
                  {!data.hosts.some((h) => h.state === 'online') && (
                    <button onClick={() => setTab('hosts')}>Open hosts & settings</button>
                  )}
                </div>
              )}
            </div>
            <div className="table-foot">
              <span>
                Resource identity: host + Docker ID{tab === 'volumes' ? ' (volume name)' : ''}
              </span>
              <span>Auto refresh · actual Docker data</span>
            </div>
          </>
        ) : (
          config && (
            <>
              <div className="section-title">
                <p>One configuration file. Changes are validated and saved atomically.</p>
                <button className="primary" onClick={() => setEditHost('new')}>
                  <Plus size={14} />
                  Add host
                </button>
              </div>
              <div className="table-scroll">
                <table className="hosts-table">
                  <thead>
                    <tr>
                      <th>Host</th>
                      <th>Agent endpoint</th>
                      <th>Credentials</th>
                      <th>Status</th>
                      <th>Last successful update</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {config.hosts.map((h) => (
                      <tr key={h.id}>
                        <td>
                          <strong>{h.name}</strong>
                          <small className="mono">{h.id}</small>
                        </td>
                        <td className="mono">{h.agentUrl}</td>
                        <td>{h.credentialRef}</td>
                        <td>
                          <Badge state={hostMap.get(h.id)?.state || 'connecting'} />
                        </td>
                        <td>{date(hostMap.get(h.id)?.lastSuccess)}</td>
                        <td className="settings-actions">
                          <button
                            onClick={() => test(h.id)}
                            disabled={testing === h.id || !h.enabled}
                          >
                            {testing === h.id ? 'Testing…' : 'Test'}
                          </button>
                          <button onClick={() => setEditHost(h)}>Edit</button>
                          <button
                            onClick={() =>
                              saveHosts(
                                config.hosts.map((x) =>
                                  x.id === h.id ? { ...x, enabled: !x.enabled } : x,
                                ),
                              ).catch((e) => setError(e.message))
                            }
                          >
                            {h.enabled ? 'Disable' : 'Enable'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!config.hosts.length && (
                  <div className="empty-state">
                    <Server size={27} />
                    <h2>Add your first Docker host</h2>
                    <p>
                      Install an agent and provision an mTLS credential reference before adding its
                      endpoint.
                    </p>
                  </div>
                )}
              </div>
              <RuntimeSettings config={config} onSave={setConfig} onError={setError} />
              <div className="config-help">
                <Settings2 size={18} />
                <div>
                  <h2>Installation settings</h2>
                  <p>
                    Credential files, TLS trust, access rules and the public URL are configured in
                    the mounted YAML or JSON file. These changes require a restart. Secret contents
                    are never shown here.
                  </p>
                  <p>
                    To edit the file manually, stop the application to avoid concurrent UI writes,
                    then validate and restart. If a conflict is reported,{' '}
                    <button
                      className="text-button"
                      onClick={() =>
                        configuration()
                          .then(setConfig)
                          .catch((e) => setError(e.message))
                      }
                    >
                      reload configuration
                    </button>{' '}
                    before saving again.
                  </p>
                  <p>
                    Public URL: <span className="mono">{config.baseUrl}</span> · Authentication:{' '}
                    {config.auth.mode}
                  </p>
                </div>
              </div>
            </>
          )
        )}
      </main>
      <footer>
        <span>
          <span className="dot online" /> Docker Fleet
        </span>
        <span>Private infrastructure · v1.0</span>
      </footer>
      {logTarget && config && (
        <LogViewer
          target={logTarget}
          hostName={hostName(logTarget.hostId)}
          config={config}
          onClose={() => setLogTarget(null)}
        />
      )}
      {editHost && config && (
        <HostEditor
          host={editHost}
          config={config}
          onClose={() => setEditHost(null)}
          onSave={async (value) => {
            const existing = editHost !== 'new';
            await saveHosts(
              existing
                ? config.hosts.map((h) => (h.id === value.id ? value : h))
                : [...config.hosts, value],
            );
          }}
        />
      )}
    </div>
  );
}
function containerNames(hostId: string | undefined, ids: string[], containers: Container[]) {
  const names = ids.map(
    (id) => containers.find((c) => c.hostId === hostId && c.id === id)?.name || id.slice(0, 12),
  );
  return names.length ? (
    <span title={names.join(', ')}>
      {names.slice(0, 3).join(', ')}
      {names.length > 3 ? ` +${names.length - 3}` : ''}
    </span>
  ) : (
    <span className="muted">Unused</span>
  );
}

function HostEditor({
  host,
  config,
  onClose,
  onSave,
}: {
  host: HostConfig | 'new';
  config: PublicConfig;
  onClose: () => void;
  onSave: (host: HostConfig) => Promise<void>;
}) {
  const [value, setValue] = useState<HostConfig>(
    host === 'new'
      ? {
          id: '',
          name: '',
          agentUrl: '',
          credentialRef: config.credentialRefs[0] || '',
          enabled: true,
          timeoutMs: 5000,
        }
      : { ...host },
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useDialog(onClose);
  const change = (field: keyof HostConfig, val: string | number | boolean) =>
    setValue((v) => ({ ...v, [field]: val }));
  return (
    <div className="overlay">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-editor-title"
      >
        <div className="dialog-heading">
          <h2 id="host-editor-title">{host === 'new' ? 'Add host' : `Edit ${host.name}`}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close host editor">
            <X size={18} />
          </button>
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            setError('');
            try {
              await onSave(value);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          <label>
            Host ID
            <input
              aria-label="Host ID"
              aria-describedby="host-id-help"
              required
              pattern="[a-zA-Z][a-zA-Z0-9_-]{0,63}"
              disabled={host !== 'new'}
              value={value.id}
              onChange={(e) => change('id', e.target.value)}
              placeholder="host-2"
            />
            <small id="host-id-help">Stable resource identity; cannot be changed here.</small>
          </label>
          <label>
            Display name
            <input
              required
              maxLength={255}
              value={value.name}
              onChange={(e) => change('name', e.target.value)}
              placeholder="Host 2"
            />
          </label>
          <label>
            Agent endpoint
            <input
              aria-label="Agent endpoint"
              aria-describedby="agent-url-help"
              required
              type="url"
              value={value.agentUrl}
              onChange={(e) => change('agentUrl', e.target.value)}
              placeholder="https://agent-2.example.invalid:9443"
            />
            <small id="agent-url-help">HTTPS with an exact matching server certificate.</small>
          </label>
          <label>
            Credential reference
            <select
              aria-label="Credential reference"
              aria-describedby="credential-help"
              required
              value={value.credentialRef}
              onChange={(e) => change('credentialRef', e.target.value)}
            >
              {config.credentialRefs.map((ref) => (
                <option key={ref}>{ref}</option>
              ))}
            </select>
            <small id="credential-help">
              Provision credential files in the configuration first, then restart.
            </small>
          </label>
          <label>
            Connection timeout (milliseconds)
            <input
              required
              type="number"
              min={200}
              max={120000}
              value={value.timeoutMs}
              onChange={(e) => change('timeoutMs', Number(e.target.value))}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) => change('enabled', e.target.checked)}
            />
            Host enabled
          </label>
          {error && (
            <div className="message error" role="alert">
              {error}
            </div>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary"
              type="submit"
              disabled={saving || !config.credentialRefs.length}
            >
              {saving ? 'Saving…' : 'Save host'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
function RuntimeSettings({
  config,
  onSave,
  onError,
}: {
  config: PublicConfig;
  onSave: (value: PublicConfig) => void;
  onError: (error: string) => void;
}) {
  const [inventoryMs, setInventory] = useState(config.polling.inventoryMs),
    [statsMs, setStats] = useState(config.polling.statsMs),
    [tail, setTail] = useState(config.logs.defaultTail),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setInventory(config.polling.inventoryMs);
    setStats(config.polling.statsMs);
    setTail(config.logs.defaultTail);
  }, [config.revision]);
  return (
    <details className="runtime-settings">
      <summary>
        Refresh & log settings <ChevronDown size={14} />
      </summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onSave(
              await api<PublicConfig>('/config', {
                method: 'PUT',
                headers: { 'If-Match': config.revision },
                body: JSON.stringify({
                  hosts: config.hosts,
                  polling: { inventoryMs, statsMs },
                  logs: { ...config.logs, defaultTail: tail },
                }),
              }),
            );
          } catch (err) {
            onError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Inventory refresh (ms)
          <input
            type="number"
            min={1000}
            max={3600000}
            required
            value={inventoryMs}
            onChange={(e) => setInventory(Number(e.target.value))}
          />
        </label>
        <label>
          Statistics refresh (ms)
          <input
            type="number"
            min={500}
            max={600000}
            required
            value={statsMs}
            onChange={(e) => setStats(Number(e.target.value))}
          />
        </label>
        <label>
          Default log tail
          <input
            type="number"
            min={1}
            max={config.logs.maxTail}
            required
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </form>
      <p>
        Host, refresh and log changes apply immediately. Listener, authentication, credential files
        and storage changes require a restart.
      </p>
    </details>
  );
}

function useDialog(onClose: () => void) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const dialog = document.querySelector('[role="dialog"]');
        const elements = [
          ...(dialog?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ) || []),
        ];
        if (!elements.length) return;
        const first = elements[0],
          last = elements.at(-1)!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    const first = document.querySelector<HTMLElement>(
      '[role="dialog"] button, [role="dialog"] input',
    );
    first?.focus();
    return () => {
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, []);
}
function LogViewer({
  target,
  hostName,
  config,
  onClose,
}: {
  target: Container;
  hostName: string;
  config: PublicConfig;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<LogLine[]>([]),
    [follow, setFollow] = useState(true),
    [tail, setTail] = useState(config.logs.defaultTail),
    [filter, setFilter] = useState(''),
    [error, setError] = useState(''),
    [state, setState] = useState('Connecting'),
    [copied, setCopied] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const buffer = useRef<LogLine[]>([]);
  useDialog(onClose);
  useEffect(() => {
    if (!follow) {
      setState('Paused');
      return;
    }
    const controller = new AbortController();
    let active = true;
    setError('');
    setState('Connecting');
    buffer.current = [];
    setLines([]);
    (async () => {
      const res = await fetch(
        `/api/hosts/${encodeURIComponent(target.hostId!)}/containers/${target.id}/logs?tail=${tail}&follow=true`,
        {
          signal: controller.signal,
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
        },
      );
      if (res.ok && !res.headers.get('content-type')?.includes('application/x-ndjson'))
        throw new Error('Authentication expired. Reload to sign in.');
      if (!res.ok) {
        const value = await res.json().catch(() => ({}));
        throw new Error(value.message || `Logs unavailable (${res.status})`);
      }
      if (!res.body) throw new Error('Streaming is not supported by this browser.');
      setState('Live');
      const reader = res.body.getReader(),
        decoder = new TextDecoder();
      let pending = '';
      let bufferSize = 0;
      const sizes: number[] = [];
      const encoder = new TextEncoder();
      while (active) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        if (pending.length > config.logs.maxBufferBytes * 2)
          throw new Error('Log response exceeded the buffer limit.');
        const chunks = pending.split('\n');
        pending = chunks.pop()!;
        for (const chunk of chunks) {
          if (!chunk.trim()) continue;
          const line = JSON.parse(chunk) as LogLine & { error?: string };
          if (line.error) throw new Error(line.error);
          if (typeof line.text !== 'string') continue;
          line.text = line.text.slice(0, config.logs.maxLineBytes);
          const size = encoder.encode(JSON.stringify(line)).length + 1;
          buffer.current.push(line);
          sizes.push(size);
          bufferSize += size;
          while (
            buffer.current.length > config.logs.maxTail ||
            bufferSize > config.logs.maxBufferBytes
          ) {
            buffer.current.shift();
            bufferSize -= sizes.shift() || 0;
          }
        }
        if (active) setLines([...buffer.current]);
      }
      if (active) {
        setState('Ended — resume to reconnect');
        setFollow(false);
      }
    })()
      .catch((e) => {
        if (active && e.name !== 'AbortError') {
          setError(e.message);
          setState('Disconnected');
          setFollow(false);
        }
      })
      .finally(() => controller.abort());
    return () => {
      active = false;
      controller.abort();
    };
  }, [target.id, target.hostId, follow, tail]);
  useEffect(() => {
    if (follow && panel.current) panel.current.scrollTop = panel.current.scrollHeight;
  }, [lines, follow]);
  const visible = lines.filter((line) => line.text.toLowerCase().includes(filter.toLowerCase()));
  const text = visible
    .map((line) => `${line.timestamp ? line.timestamp + ' ' : ''}[${line.stream}] ${line.text}`)
    .join('\n');
  return (
    <div className="overlay log-overlay">
      <section className="log-dialog" role="dialog" aria-modal="true" aria-labelledby="logs-title">
        <div className="dialog-heading">
          <div>
            <h2 id="logs-title">
              <ScrollText size={18} />
              {target.name}
            </h2>
            <p>
              {hostName} · {target.id.slice(0, 12)}
            </p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close logs">
            <X size={19} />
          </button>
        </div>
        <div className="log-toolbar">
          <label>
            Tail
            <input
              aria-label="Log tail lines"
              type="number"
              min={1}
              max={config.logs.maxTail}
              value={tail}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (n >= 1 && n <= config.logs.maxTail) setTail(n);
              }}
            />
          </label>
          <button onClick={() => setFollow(!follow)}>
            {follow ? <Pause size={14} /> : <Play size={14} />}
            {follow ? 'Pause follow' : 'Resume follow'}
          </button>
          <label className="search">
            <Search size={14} />
            <input
              aria-label="Filter logs"
              placeholder="Filter visible logs…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              } catch {
                setError('Clipboard access unavailable. Use Download instead.');
              }
            }}
          >
            <Copy size={14} />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            onClick={() => {
              const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = `logs-${target.hostId}-${target.name.replace(/[^a-z0-9_-]/gi, '_')}.txt`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download size={14} />
            Download
          </button>
        </div>
        {error && (
          <div className="message error" role="alert">
            {error}
          </div>
        )}
        <div className="log-output" ref={panel} tabIndex={0} aria-label="Container log output">
          {visible.map((line, i) => (
            <div key={i} className={`log-line ${line.stream}`}>
              <time>{line.timestamp || ''}</time>
              <span className="log-source">{line.stream}</span>
              <span>
                {line.text}
                {line.truncated && ' [truncated]'}
              </span>
            </div>
          ))}
          {!visible.length && (
            <p className="muted">
              {state === 'Connecting'
                ? 'Connecting to Docker logs…'
                : 'No log lines in this excerpt.'}
            </p>
          )}
        </div>
        <div className="log-foot">
          <span>
            <span className={`dot ${state === 'Live' ? 'online' : 'connecting'}`} />
            {state} · {visible.length}/{lines.length} lines
          </span>
          <span>
            Bounded excerpt · {bytes(config.logs.maxBufferBytes)} max
            {!follow && ' · resume loads a fresh tail; gaps are possible'}
          </span>
        </div>
      </section>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
