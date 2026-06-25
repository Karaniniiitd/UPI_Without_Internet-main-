import crypto from 'crypto';
import { encrypt, serverKey } from './crypto.js';

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Simulates a client device composing, signing, and encrypting a transaction.
 */
export function createPacket(senderVpa, receiverVpa, amount, pin, ttl) {
  const instruction = {
    senderVpa,
    receiverVpa,
    amount: Number(amount),
    pinHash: sha256Hex(pin),
    nonce: crypto.randomUUID(),
    signedAt: Date.now()
  };

  const ciphertext = encrypt(instruction, serverKey.publicKey);

  return {
    packetId: crypto.randomUUID(),
    ttl: Number(ttl),
    createdAt: Date.now(),
    ciphertext
  };
}
