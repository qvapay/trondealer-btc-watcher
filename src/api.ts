import Fastify from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from './logger.js';
import { store } from './store.js';

const API_SECRET = process.env.API_SECRET || '';

function verifyApiAuth(headerSig: string | undefined, body: string): boolean {
  if (!headerSig || !API_SECRET) return false;
  const expected = createHmac('sha256', API_SECRET).update(body).digest('hex');
  const actual = headerSig.replace(/^sha256=/, '');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  } catch { return false; }
}

export function createApp() {
  const app = Fastify({ logger: false });

  // Health check (sin auth)
  app.get('/health', async () => ({ status: 'ok', stats: store.stats() }));

  // Hook de auth para endpoints de /watch
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health') return;
    const sig = req.headers['x-api-signature'] as string | undefined;
    const body = JSON.stringify(req.body || {});
    if (!verifyApiAuth(sig, body)) {
      logger.warn({ url: req.url, ip: req.ip }, 'auth failed');
      return reply.code(401).send({ error: 'invalid signature' });
    }
  });

  // POST /watch — registrar dirección a monitorear
  app.post<{
    Body: {
      address: string;
      expected_sats?: number;
      callback_url: string;
      hmac_secret: string;
      ttl_seconds?: number;
    };
  }>('/watch', async (req, reply) => {
    const { address, expected_sats, callback_url, hmac_secret, ttl_seconds = 3600 } = req.body;
    if (!address || !callback_url || !hmac_secret) {
      return reply.code(400).send({ error: 'missing required fields' });
    }
    const watch = store.add({
      address,
      expected_sats,
      callback_url,
      hmac_secret,
      expires_at: Date.now() + ttl_seconds * 1000,
    });
    logger.info({ id: watch.id, address }, 'watch added');
    return { id: watch.id, status: watch.status };
  });

  // DELETE /watch/:id
  app.delete<{ Params: { id: string } }>('/watch/:id', async (req, reply) => {
    const ok = store.remove(req.params.id);
    return { removed: ok };
  });

  // GET /watch/:id — estado actual
  app.get<{ Params: { id: string } }>('/watch/:id', async (req, reply) => {
    const watch = store.get(req.params.id);
    if (!watch) return reply.code(404).send({ error: 'not found' });
    // No retornar el hmac_secret en respuestas
    const { hmac_secret, ...safe } = watch;
    return safe;
  });

  // GET /watches — listar todas (debug)
  app.get('/watches', async () => {
    return store.list().map(w => {
      const { hmac_secret, ...safe } = w;
      return safe;
    });
  });

  return app;
}
