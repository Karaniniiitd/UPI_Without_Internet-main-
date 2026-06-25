import { decrypt, hashCiphertext, serverKey } from './crypto.js';
import { idempotencyService } from './idempotency.js';
import { settle } from './settlement.js';

const MAX_AGE_SECONDS = 86400; // 24 hours

/**
 * Orchestrates the backend packet validation pipeline:
 * 1. Compute SHA-256 of the ciphertext to get a unique hash.
 * 2. Deduplicate using the idempotency service.
 * 3. Decrypt hybrid RSA+AES package.
 * 4. Verify freshness (creation timestamp must be within 24h).
 * 5. Update balances and log to database ledger.
 */
export async function ingest(packet, bridgeNodeId, hopCount) {
  try {
    const packetHash = hashCiphertext(packet.ciphertext);

    // 1. Idempotency check
    if (!idempotencyService.claim(packetHash)) {
      console.log(`DUPLICATE packet ${packetHash.substring(0, 12)}... from bridge ${bridgeNodeId} — dropped`);
      return {
        outcome: 'DUPLICATE_DROPPED',
        packetHash,
        reason: null,
        transactionId: null
      };
    }

    // 2. Decryption using server's RSA private key
    let instruction;
    try {
      instruction = decrypt(packet.ciphertext, serverKey.privateKey);
    } catch (e) {
      console.warn(`Decryption failed for packet ${packetHash.substring(0, 12)}...: ${e.message}`);
      return {
        outcome: 'INVALID',
        packetHash,
        reason: 'decryption_failed',
        transactionId: null
      };
    }

    // 3. Freshness check (replay attack protection)
    const now = Date.now();
    const ageSeconds = (now - instruction.signedAt) / 1000;
    if (ageSeconds > MAX_AGE_SECONDS) {
      console.warn(`Packet ${packetHash.substring(0, 12)}... too old (${ageSeconds.toFixed(1)}s), rejected`);
      return {
        outcome: 'INVALID',
        packetHash,
        reason: 'stale_packet',
        transactionId: null
      };
    }
    if (ageSeconds < -300) { // Clock skew tolerance
      console.warn(`Packet ${packetHash.substring(0, 12)}... is future-dated (${ageSeconds.toFixed(1)}s), rejected`);
      return {
        outcome: 'INVALID',
        packetHash,
        reason: 'future_dated',
        transactionId: null
      };
    }

    // 4. Settle debit/credit
    const tx = await settle(instruction, packetHash, bridgeNodeId, hopCount);
    return {
      outcome: 'SETTLED',
      packetHash,
      reason: null,
      transactionId: tx.id
    };

  } catch (e) {
    console.error(`Ingestion error: ${e.message}`, e);
    return {
      outcome: 'INVALID',
      packetHash: '?',
      reason: `internal_error: ${e.message}`,
      transactionId: null
    };
  }
}
