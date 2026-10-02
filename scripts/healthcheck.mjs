import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { parse } from 'yaml';

// A local liveness check, never a substitute for the authenticated API check.
// /healthz intentionally contains no resource inventory or identity information.
const mode = process.argv[2];
let port;
let tls;
let ca;
let servername = process.env.HEALTHCHECK_SERVER_NAME;
try {
  if (mode === 'agent') {
    port = Number(process.env.AGENT_PORT || 9443);
    tls = process.env.AGENT_DEV_MODE !== '1' && !!process.env.AGENT_TLS_CERT;
    if (tls) ca = fs.readFileSync(process.env.HEALTHCHECK_CA_FILE || process.env.AGENT_TLS_CA);
  } else if (mode === 'server') {
    const config = parse(fs.readFileSync(process.env.CONFIG_FILE || '/config/config.yml', 'utf8'));
    port = config.server.port;
    tls = config.auth.mode === 'proxy' && !!config.server.tls;
    if (tls) ca = fs.readFileSync(process.env.HEALTHCHECK_CA_FILE || config.server.tls.proxyCaFile);
  } else throw new Error('Expected server or agent');
  const client = tls ? https : http;
  const request = client.get(
    { hostname: '127.0.0.1', port, path: '/healthz', ca, servername, timeout: 3000 },
    (response) => {
      response.resume();
      response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 1));
    },
  );
  request.on('timeout', () => request.destroy(new Error('Healthcheck timed out')));
  request.on('error', () => process.exit(1));
} catch {
  process.exit(1);
}
