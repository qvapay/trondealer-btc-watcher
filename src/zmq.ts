import { Subscriber } from 'zeromq';
import { address as btcAddress, Block, Transaction } from 'bitcoinjs-lib';
import { logger } from './logger.js';
import { store } from './store.js';
import { sendWebhook } from './webhook.js';

const BITCOIND_ZMQ_RAWTX = process.env.BITCOIND_ZMQ_RAWTX || 'tcp://bitcoind:28333';
const BITCOIND_ZMQ_RAWBLOCK = process.env.BITCOIND_ZMQ_RAWBLOCK || 'tcp://bitcoind:28332';

const CONFIRMATIONS_TARGET = 6;

// Últimos bloques que anunció bitcoind (hash -> padre, altura y txids). Las confirmaciones
// se miden por ascendencia desde la punta, no contando avisos: si un reorg deja huérfano el
// bloque de un pago, ese bloque sale del camino y el pago deja de sumar.
const RECENT_BLOCKS = 24;
type SeenBlock = { prev: string; height: number | null; txids: Set<string> };
const recentBlocks = new Map<string, SeenBlock>();

/** Altura BIP34: el script del coinbase empieza por la altura (push mínimo, little-endian). */
function coinbaseHeight(block: Block): number | null {
  const script = block.transactions?.[0]?.ins[0]?.script;
  const op = script?.[0];
  if (!script || op === undefined) return null;
  if (op >= 0x51 && op <= 0x60) return op - 0x50;
  if (op < 1 || op > 8 || script.length < 1 + op) return null;
  let height = 0;
  for (let i = op; i >= 1; i--) height = height * 256 + (script[i] ?? 0);
  return height;
}

function rememberBlock(block: Block): string {
  const hash = block.getId();
  recentBlocks.set(hash, {
    prev: Buffer.from(block.prevHash ?? new Uint8Array(32)).reverse().toString('hex'),
    height: coinbaseHeight(block),
    txids: new Set((block.transactions ?? []).map(tx => tx.getId())),
  });
  for (const oldest of recentBlocks.keys()) {
    if (recentBlocks.size <= RECENT_BLOCKS) break;
    recentBlocks.delete(oldest);
  }
  return hash;
}

/**
 * Profundidad de `txid` en la cadena que termina en `tip` (1 = en la punta). 0 si no está en
 * esa cadena: ningún bloque visto la contiene, o el camino llega a la altura del bloque que la
 * contenía y ahí hay otro (reorg). null si falta un bloque antes de saberlo (aviso de ZMQ
 * perdido, arranque reciente): entonces no se cambia nada, nunca se sobrestima.
 */
function depthInChain(tip: string, txid: string): number | null {
  const containing = [...recentBlocks.values()].filter(b => b.txids.has(txid));
  if (containing.length === 0) return 0;
  const heights = containing.map(b => b.height);
  const lowest = heights.every((h): h is number => h !== null) ? Math.min(...heights) : null;

  let hash = tip;
  for (let depth = 1; depth <= RECENT_BLOCKS; depth++) {
    const block = recentBlocks.get(hash);
    if (!block) return null;
    if (block.txids.has(txid)) return depth;
    if (lowest !== null && block.height !== null && block.height <= lowest) return 0;
    hash = block.prev;
  }
  return 0;
}

function txOutputsToAddresses(tx: Transaction): Array<{ address: string; value: number }> {
  const results: Array<{ address: string; value: number }> = [];
  for (const output of tx.outs) {
    try {
      // bitcoinjs-lib v7 da el valor en bigint; los sats siempre caben en un Number
      results.push({ address: btcAddress.fromOutputScript(output.script), value: Number(output.value) });
    } catch {
      // Output con script no estándar, ignorar
    }
  }
  return results;
}

export async function handleRawTx(rawTx: Buffer) {
  const tx = Transaction.fromBuffer(rawTx);
  const txid = tx.getId();
  const outputs = txOutputsToAddresses(tx);

  for (const { address, value } of outputs) {
    const watches = store.getByAddress(address);
    for (const watch of watches) {
      if (watch.status !== 'pending') continue;

      logger.info({ txid, address, value, watch_id: watch.id }, 'mempool match');

      store.update(watch.id, {
        status: 'detected_mempool',
        detected_txid: txid,
        detected_at: Date.now(),
        detected_amount_sats: value,
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

export async function handleRawBlock(rawBlock: Buffer) {
  let block: Block;
  try {
    block = Block.fromBuffer(rawBlock);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'failed to decode block');
    return;
  }

  const blockHash = rememberBlock(block);
  logger.debug({ blockHash, txCount: block.transactions?.length ?? 0 }, 'new block');

  // El store se relee tras cada webhook: mientras se espera uno, el bucle de rawtx puede
  // detectar otro pago de este mismo bloque, y una copia previa lo seguiría viendo pending
  const handled = new Set<string>();
  for (;;) {
    const watch = store.list().find(w => !handled.has(w.id) && w.status === 'detected_mempool' && !!w.detected_txid);
    if (!watch?.detected_txid) break;
    handled.add(watch.id);

    const newConfs = depthInChain(blockHash, watch.detected_txid);
    if (newConfs === null || newConfs === (watch.confirmations ?? 0)) continue;
    if (newConfs < (watch.confirmations ?? 0)) {
      logger.warn({ watch_id: watch.id, txid: watch.detected_txid, from: watch.confirmations, to: newConfs, blockHash }, 'payment left the active chain (reorg)');
    }
    store.update(watch.id, {
      confirmations: newConfs,
      status: newConfs >= CONFIRMATIONS_TARGET ? 'confirmed' : 'detected_mempool',
    });

    await sendWebhook(watch.callback_url, watch.hmac_secret, {
      event: 'confirmation',
      watch_id: watch.id,
      address: watch.address,
      txid: watch.detected_txid,
      amount_sats: watch.detected_amount_sats ?? 0,
      confirmations: newConfs,
      block_hash: blockHash,
      timestamp: Date.now(),
    });
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
