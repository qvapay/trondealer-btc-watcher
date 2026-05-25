# trondealer-btc-watcher

Real-time Bitcoin mempool watcher with HMAC-signed webhook notifications.

Built for [TronDealer](https://trondealer.qvapay.com) — a multi-chain USDT/USDC payment gateway from the [QvaPay](https://qvapay.com) ecosystem.

![License](https://img.shields.io/badge/license-MIT-yellow.svg)
![Node.js](https://img.shields.io/badge/node-22.x-green)
![TypeScript](https://img.shields.io/badge/typescript-5.7-blue)
![Docker](https://img.shields.io/badge/docker-ready-blue)
![Status](https://img.shields.io/badge/status-beta-orange)

## Why this exists

When a customer sends BTC to a TronDealer-generated address, the gateway needs to know within seconds — not after the next block (~10 min). Polling `bitcoind` every few seconds is wasteful and still slow. Watching the mempool via ZMQ is **instant** — typically under one second from broadcast to webhook delivery.

This watcher sits between your `bitcoind` node and your gateway API:

```
            ┌──────────────┐
            │   bitcoind   │   full node
            │  (mainnet)   │   with txindex=1
            └──────┬───────┘
                   │ ZMQ tcp://bitcoind:28333  (rawtx)
                   │ ZMQ tcp://bitcoind:28332  (rawblock)
                   ▼
        ┌──────────────────────┐
        │ trondealer-btc-      │   Node.js + TypeScript
        │     watcher          │   In-memory watch store
        │                      │   Fastify HTTP API
        └──────────┬───────────┘
                   │ HTTPS POST
                   │ X-Webhook-Signature: sha256=<hmac>
                   ▼
        ┌──────────────────────┐
        │  TronDealer API      │   Verifies HMAC
        │  (or any consumer)   │   Updates payment state
        └──────────────────────┘
```

## Features

- **Sub-second mempool detection** via ZMQ subscription instead of RPC polling
- **Multi-stage notifications** — fires webhook on mempool detection AND each subsequent confirmation
- **HMAC-signed webhooks** with per-watch shared secrets
- **Authenticated control API** with HMAC verification on all `/watch` endpoints
- **Retry with exponential backoff** — 3 attempts (1s, 2s, 4s) before giving up
- **TTL-based expiration** — watches auto-expire after configurable timeout
- **All address formats supported**:
  - Legacy P2PKH (`1...`)
  - SegWit P2SH (`3...`)
  - Native SegWit Bech32 (`bc1q...`)
  - Taproot Bech32m (`bc1p...`)
- **Stateless** — in-memory store, consumer re-registers on bootstrap
- **Production-ready** — graceful shutdown, structured Pino logging, Docker-first

## Quick start

### Prerequisites

A running `bitcoind` with these settings in `bitcoin.conf`:

```ini
zmqpubrawblock=tcp://0.0.0.0:28332
zmqpubrawtx=tcp://0.0.0.0:28333
```

Docker and Docker Compose.

### Run with Docker Compose

Add this service to your `compose.yml`:

```yaml
services:
  trondealer-watcher:
    build: ./trondealer-btc-watcher
    container_name: trondealer-watcher
    restart: unless-stopped
    depends_on:
      bitcoind:
        condition: service_healthy
    environment:
      LOG_LEVEL: info
      NODE_ENV: production
      PORT: 4000
      HOST: 0.0.0.0
      BITCOIND_ZMQ_RAWTX: tcp://bitcoind:28333
      BITCOIND_ZMQ_RAWBLOCK: tcp://bitcoind:28332
      API_SECRET: ${WATCHER_API_SECRET}
    ports:
      - "127.0.0.1:4000:4000"
    networks:
      - btc
```

Generate the API secret and bring up the service:

```bash
echo "WATCHER_API_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up -d trondealer-watcher
docker logs -f trondealer-watcher
```

You should see:

```
INF subscribed to rawtx tcp://bitcoind:28333
INF subscribed to rawblock tcp://bitcoind:28332
INF trondealer-watcher started port=4000
```

## API reference

### Authentication

All `/watch*` endpoints require an `X-Api-Signature` header:

```
X-Api-Signature: sha256=<hex hmac>
```

Where `hmac = HMAC-SHA256(API_SECRET, raw_request_body)`.

The `/health` endpoint is unauthenticated.

### POST /watch

Register a Bitcoin address to monitor.

Request:

```json
{
  "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  "expected_sats": 100000,
  "callback_url": "https://api.example.com/btc/webhook",
  "hmac_secret": "shared-secret-for-this-specific-watch",
  "ttl_seconds": 3600
}
```

| Field | Required | Description |
|---|---|---|
| `address` | yes | Bitcoin address to monitor |
| `callback_url` | yes | URL to POST webhooks to |
| `hmac_secret` | yes | Shared secret for HMAC-signing this watch's webhooks |
| `expected_sats` | no | Expected payment amount, for validation |
| `ttl_seconds` | no | Default `3600`. Auto-expire after this duration |

Response:

```json
{ "id": "550e8400-e29b-41d4-a716-446655440000", "status": "pending" }
```

### GET /watch/:id

Retrieve the current state of a watch.

```json
{
  "id": "550e8400-...",
  "address": "bc1q...",
  "expected_sats": 100000,
  "callback_url": "https://api.example.com/btc/webhook",
  "expires_at": 1779603600000,
  "status": "detected_mempool",
  "created_at": 1779600000000,
  "detected_txid": "abc...",
  "detected_at": 1779600045000,
  "confirmations": 0
}
```

The `hmac_secret` is never returned in responses.

### DELETE /watch/:id

Stop monitoring an address.

```json
{ "removed": true }
```

### GET /watches

List all registered watches. Useful for debugging.

### GET /health

Liveness probe. No authentication required.

```json
{
  "status": "ok",
  "stats": {
    "total": 42,
    "by_status": { "pending": 30, "detected_mempool": 5, "confirmed": 7 },
    "unique_addresses": 41
  }
}
```

## Webhook payload

When a watched address receives funds, the watcher sends `POST {callback_url}`:

Headers:

```
Content-Type: application/json
User-Agent: trondealer-watcher/0.1
X-Webhook-Signature: sha256=<hex hmac>
X-Webhook-Event: mempool_detected | confirmation | expired
X-Webhook-Watch-Id: <uuid>
```

Body:

```json
{
  "event": "mempool_detected",
  "watch_id": "550e8400-...",
  "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  "txid": "abc123...",
  "amount_sats": 100000,
  "confirmations": 0,
  "block_hash": "00000000...",
  "block_height": 950900,
  "timestamp": 1779600045000
}
```

### Event lifecycle

```
                  POST /watch
                  status: pending
                       │
            ┌──────────┴──────────┐
            │                     │
   tx hits mempool          ttl expires
            │                     │
            ▼                     ▼
   event: mempool_detected   event: expired
   confirmations: 0          status: expired
   status: detected_mempool
            │
            ▼  (included in block)
   event: confirmation
   confirmations: 1
            │
            ▼  (next block)
   event: confirmation
   confirmations: 2
            │
            ▼  ... up to 6
   event: confirmation
   confirmations: 6
   status: confirmed
```

### Verifying webhook signatures

Pseudo-code for the consumer:

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyWebhook(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = signature.replace(/^sha256=/, '');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}
```

Verify against the **raw bytes** of the request body, not the parsed JSON. Re-stringifying changes byte order and breaks the HMAC.

## Environment variables

| Variable | Default | Required | Description |
|---|---|---|---|
| `PORT` | `4000` | | HTTP API listen port |
| `HOST` | `0.0.0.0` | | HTTP bind address |
| `API_SECRET` | — | yes | Shared secret for `/watch*` authentication. Generate with `openssl rand -hex 32` |
| `BITCOIND_ZMQ_RAWTX` | `tcp://bitcoind:28333` | | bitcoind ZMQ rawtx endpoint |
| `BITCOIND_ZMQ_RAWBLOCK` | `tcp://bitcoind:28332` | | bitcoind ZMQ rawblock endpoint |
| `LOG_LEVEL` | `info` | | Pino log level: trace, debug, info, warn, error, fatal |
| `NODE_ENV` | `development` | | Set to `production` to disable pretty-print logs |

## Development

```bash
git clone https://github.com/qvapay/trondealer-btc-watcher
cd trondealer-btc-watcher
npm install
cp .env.example .env
npm run dev
```

### Project structure

```
src/
├── index.ts     Entry point. Bootstraps API + ZMQ subscribers + shutdown hooks
├── api.ts       Fastify HTTP server, auth hook, /watch* endpoints
├── zmq.ts       ZMQ subscribers for rawtx/rawblock + match logic
├── store.ts     In-memory watch store with address index + TTL expiration
├── webhook.ts   HMAC-signed webhook delivery with retry/backoff
├── logger.ts    Pino logger setup (pretty in dev, JSON in prod)
└── types.ts     Shared TypeScript types
```

### Build for production

```bash
npm run build
node dist/index.js
```

Or use the Docker image:

```bash
docker build -t trondealer-btc-watcher:latest .
```

## Security model

This service handles payment notifications, not funds. Misuse can still cause real harm:

| Attack vector | Defense |
|---|---|
| Unauthorized watch creation | All `/watch*` calls require `X-Api-Signature` HMAC verified against `API_SECRET` |
| Spoofed webhooks to consumer | Webhooks signed per-watch with `hmac_secret`. Consumer must verify |
| Replay attacks | Include `timestamp` in payload. Consumer rejects requests older than N seconds |
| Address poisoning | Consumer should validate that `address` in webhook matches the one originally registered |
| Timing attacks on HMAC | Uses `timingSafeEqual` for all comparisons |

What this service does **not** do:

- Hold private keys
- Initiate payments
- Decide whether a payment is "valid" — it observes and reports
- Validate transactions beyond "this tx pays this address"

The consumer is responsible for:

- Comparing `amount_sats` against expected payment
- Deciding at how many confirmations to consider a payment settled
- De-duplicating events (mempool + confirmations for the same `watch_id` can each fire multiple times in rare reorg scenarios)

## Testing

```bash
# Health check
curl -s http://localhost:4000/health | jq

# Register a watch (HMAC computed in bash)
BODY='{"address":"bc1q...","callback_url":"https://example.com/hook","hmac_secret":"test"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$API_SECRET" | awk '{print $2}')
curl -X POST http://localhost:4000/watch \
  -H "Content-Type: application/json" \
  -H "X-Api-Signature: sha256=$SIG" \
  -d "$BODY"
```

## Roadmap

- [ ] Persistent store option (Redis or PostgreSQL) for stateful restart
- [ ] WebSocket interface for real-time event streaming in addition to webhooks
- [ ] Multi-output transaction support (currently fires one event per matching output)
- [ ] Reorg handling — currently does not roll back confirmation events
- [ ] Bulk register/unregister endpoint
- [ ] Prometheus `/metrics` endpoint
- [ ] Address derivation: register an xpub and watch all derived addresses
- [ ] Support for OP_RETURN payload matching for tagged transactions

## Related projects

This watcher is part of the broader QvaPay infrastructure:

- [QvaPay](https://www.qvapay.com) — P2P fintech platform serving 150K+ users across the Cuban diaspora and LATAM
- TronDealer — Multi-chain USDT/USDC payment gateway (TRON, BSC, Polygon, Ethereum)
- BitRemesas — US-to-LATAM remittances via stablecoin rails

## Contributing

This is an internal QvaPay project, but issues and PRs are welcome. Especially:

- Bug reports with clear repro steps
- Performance improvements
- Additional address format support
- Documentation improvements

## License

MIT — see [LICENSE](LICENSE).

---

Built in Des Plaines, IL by [@erichgarciacruz](https://x.com/erichgarciacruz) for the QvaPay community.

Lightning Address: `erich@qvapay.com` (coming soon — being built right now).
