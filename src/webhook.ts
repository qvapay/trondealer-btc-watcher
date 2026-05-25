import { createHmac } from 'node:crypto';
import { logger } from './logger.js';
import type { PaymentEvent } from './types.js';

export async function sendWebhook(
  url: string,
  secret: string,
  payload: PaymentEvent,
  retries = 3
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(body).digest('hex');

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Webhook-Event': payload.event,
          'X-Webhook-Watch-Id': payload.watch_id,
          'User-Agent': 'trondealer-watcher/0.1',
        },
        body,
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        logger.info({ event: payload.event, watch_id: payload.watch_id, attempt }, 'webhook delivered');
        return true;
      }

      logger.warn({ status: response.status, attempt }, 'webhook non-2xx response');
    } catch (err) {
      logger.warn({ err: (err as Error).message, attempt }, 'webhook delivery failed');
    }

    // Exponential backoff
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }

  logger.error({ event: payload.event, watch_id: payload.watch_id }, 'webhook permanently failed');
  return false;
}
