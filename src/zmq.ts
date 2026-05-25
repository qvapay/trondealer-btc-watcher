import { Subscriber } from 'zeromq';
import { Transaction } from 'bitcoinjs-lib';
import { logger } from './logger.js';
import { store } from './store.js';
import { sendWebhook } from './webhook.js';

const BITCOIND_ZMQ_RAWTX = process.env.BITCOIND_ZMQ_RAWTX || 'tcp://bitcoind:28333';
const BITCOIND_ZMQ_RAWBLOCK = process.env.BITCOIND_ZMQ_RAWBLOCK || 'tcp://bitcoind:28332';

function txOutputsToAddresses(rawTx: Buffer): Array<{ address: string; value: number }> {
  try {
    const tx = Transaction.fromBuffer(rawTx);
    const results: Array<{ address: string; value: number }> = [];

    for (const output of tx.outs) {
      try {
        // bitcoinjs-lib's address.fromOutputScript handles common script types
        const { address } = require('bitcoinjs-lib').address;
        const addr = address.fromOutputScript(output.script);
        results.push({ address: addr, value: output.value });
      } catch {
        // Output con script no estándar, ignorar
      }
    }
    return results;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to decode tx');
    return [];
  }
}

async function handleRawTx(rawTx: Buffer) {
  const tx = Transaction.fromBuffer(rawTx);
  const txid = tx.getId();
  const outputs = txOutputsToAddresses(rawTx);

  for (const { address, value } of outputs) {
    const watches = store.getByAddress(address);
    for (const watch of watches) {
      if (watch.status !== 'pending') continue;

      logger.info({ txid, address, value, watch_id: watch.id }, 'mempool match');

      store.update(watch.id, {
        status: 'detected_mempool',
        detected_txid: txid,
        detected_at: Date.now(),
        confirmations: 0,
      });

      await sendWebhook(watch.callback_url, watch.hmac_secret, {
        event: 'mempool_detected',
        watch_id: watch.id,
        address,
        txid,
        amount_sats: value,
        confirmations: 0,
        timestamp: Date.now(),
      });
    }
  }
}

async function handleRawBlock(rawBlock: Buffer) {
  // bitcoinjs-lib Block parsing
  const { Block } = require('bitcoinjs-lib');
  let block;
  try {
    block = Block.fromBuffer(rawBlock);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to decode block');
    return;
  }

  const blockHash = block.getId();
  logger.debug({ blockHash, txCount: block.transactions?.length }, 'new block');

  if (!block.transactions) return;

  for (const tx of block.transactions) {
    const txid = tx.getId();
    // Buscar todas las watches con este txid
    for (const watch of store.list()) {
      if (watch.detected_txid !== txid) continue;

      const newConfs = (watch.confirmations ?? 0) + 1;
      store.update(watch.id, {
        confirmations: newConfs,
        status: newConfs >= 6 ? 'confirmed' : 'detected_mempool',
      });

      const output = tx.outs.find((o: any) => {
        try {
          const { address } = require('bitcoinjs-lib').address;
          return address.fromOutputScript(o.script) === watch.address;
        } catch { return false; }
      });

      await sendWebhook(watch.callback_url, watch.hmac_secret, {
        event: 'confirmation',
        watch_id: watch.id,
        address: watch.address,
        txid,
        amount_sats: output?.value || 0,
        confirmations: newConfs,
        block_hash: blockHash,
        timestamp: Date.now(),
      });
    }
  }
}

export async function startZmqSubscribers() {
  // Suscriptor de transacciones
  const txSock = new Subscriber();
  txSock.connect(BITCOIND_ZMQ_RAWTX);
  txSock.subscribe('rawtx');
  logger.info({ endpoint: BITCOIND_ZMQ_RAWTX }, 'subscribed to rawtx');

  // Suscriptor de bloques
  const blockSock = new Subscriber();
  blockSock.connect(BITCOIND_ZMQ_RAWBLOCK);
  blockSock.subscribe('rawblock');
  logger.info({ endpoint: BITCOIND_ZMQ_RAWBLOCK }, 'subscribed to rawblock');

  // Loop de procesamiento (concurrente)
  (async () => {
    for await (const [topic, msg] of txSock) {
      try { await handleRawTx(msg); }
      catch (err) { logger.error({ err: (err as Error).message }, 'rawtx handler error'); }
    }
  })();

  (async () => {
    for await (const [topic, msg] of blockSock) {
      try { await handleRawBlock(msg); }
      catch (err) { logger.error({ err: (err as Error).message }, 'rawblock handler error'); }
    }
  })();
}
