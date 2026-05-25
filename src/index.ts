import { createApp } from './api.js';
import { startZmqSubscribers } from './zmq.js';
import { store } from './store.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  // ZMQ subscribers (async, concurrente)
  await startZmqSubscribers();

  // HTTP API
  const app = createApp();
  await app.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT }, 'trondealer-watcher started');

  // Expire old watches cada minuto
  setInterval(() => {
    const expired = store.expireOld();
    if (expired > 0) logger.info({ expired }, 'expired old watches');
  }, 60000);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  logger.fatal({ err: err.message }, 'startup failed');
  process.exit(1);
});
