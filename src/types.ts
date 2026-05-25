export interface WatchedAddress {
  id: string;                    // UUID del registro
  address: string;               // bc1q... que monitoreamos
  expected_sats?: number;        // monto esperado (opcional, para validación)
  callback_url: string;          // URL de TronDealer para webhook
  hmac_secret: string;           // shared secret para firmar el webhook
  expires_at?: number;           // timestamp epoch ms cuando expira
  status: 'pending' | 'detected_mempool' | 'confirmed' | 'expired';
  created_at: number;
  // Estado interno
  detected_txid?: string;
  detected_at?: number;
  confirmations?: number;
}

export interface PaymentEvent {
  event: 'mempool_detected' | 'confirmation' | 'expired';
  watch_id: string;
  address: string;
  txid: string;
  amount_sats: number;
  confirmations: number;
  block_hash?: string;
  block_height?: number;
  timestamp: number;
}
