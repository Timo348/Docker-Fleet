import { createServer } from './app.js';

async function main(): Promise<void> {
  const server = await createServer();
  process.on('SIGHUP', () => {
    void server.store
      .reload()
      .then(() => process.stderr.write('Configuration reloaded.\n'))
      .catch((error) =>
        process.stderr.write(
          `Configuration reload rejected: ${error instanceof Error ? error.message : 'invalid configuration'}\n`,
        ),
      );
  });
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      void server.app
        .close()
        .then(() => {
          process.exitCode = 0;
        })
        .catch(() => {
          process.exitCode = 1;
        });
    });
  await server.listen();
  process.stdout.write('Docker Fleet server listening.\n');
}
main().catch((error) => {
  // Never print config bodies, TLS keys, identity headers or Docker responses.
  process.stderr.write(
    `Startup failed: ${error instanceof Error ? error.message : 'invalid startup configuration'}\n`,
  );
  process.exitCode = 1;
});
