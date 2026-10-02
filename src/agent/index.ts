import { createAgent, loadAgentOptions } from './server.js';

try {
  const options = loadAgentOptions();
  const agent = createAgent(options);
  agent.server.on('error', () => {
    console.error(
      'Agent listener could not start. Check bind address, port and TLS configuration.',
    );
    process.exitCode = 1;
  });
  agent.server.listen(options.port, options.bind, () =>
    console.info(
      `Docker Fleet agent ready for host ${options.hostId} on ${options.bind}:${options.port}${options.development ? ' (explicit loopback development mode)' : ' (mTLS required)'}.`,
    ),
  );
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void agent.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(
    `Agent startup rejected: ${error instanceof Error ? error.message : 'Invalid configuration.'}`,
  );
  process.exitCode = 1;
}
