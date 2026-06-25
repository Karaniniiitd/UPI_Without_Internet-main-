import assert from 'assert';
import { createPacket, sha256Hex } from '../src-node/demo.js';
import { ingest } from '../src-node/ingestion.js';
import { getAccount, initDb } from '../src-node/db.js';
import { encrypt, decrypt, serverKey } from '../src-node/crypto.js';
import { idempotencyService } from '../src-node/idempotency.js';

async function runTests() {
  console.log("Starting test suite...");

  // Test 1: Cryptography Roundtrip
  console.log("Running Cryptography Roundtrip Test...");
  const samplePayload = {
    senderVpa: "alice@demo",
    receiverVpa: "bob@demo",
    amount: 100,
    pinHash: sha256Hex("1234"),
    nonce: "test-nonce-123",
    signedAt: Date.now()
  };
  const ciphertext = encrypt(samplePayload, serverKey.publicKey);
  const decrypted = decrypt(ciphertext, serverKey.privateKey);
  assert.strictEqual(decrypted.senderVpa, samplePayload.senderVpa);
  assert.strictEqual(decrypted.amount, samplePayload.amount);
  console.log("✓ Cryptography Roundtrip Test passed");

  // Test 2: Concurrency & Idempotency
  console.log("Running Concurrency & Idempotency Test...");
  initDb();
  idempotencyService.clear();

  const packet = createPacket("alice@demo", "bob@demo", 500, "1234", 5);

  // Fire three ingestion requests concurrently
  const promises = [
    ingest(packet, "bridge-1", 1),
    ingest(packet, "bridge-2", 1),
    ingest(packet, "bridge-3", 1)
  ];

  const results = await Promise.all(promises);

  const settledCount = results.filter(r => r.outcome === 'SETTLED').length;
  const duplicateCount = results.filter(r => r.outcome === 'DUPLICATE_DROPPED').length;

  assert.strictEqual(settledCount, 1, "Exactly 1 request must be SETTLED");
  assert.strictEqual(duplicateCount, 2, "Exactly 2 requests must be DUPLICATE_DROPPED");

  const alice = await getAccount("alice@demo");
  const bob = await getAccount("bob@demo");
  
  assert.strictEqual(alice.balance, 4500, "Alice's balance should be decremented once");
  assert.strictEqual(bob.balance, 1500, "Bob's balance should be incremented once");
  console.log("✓ Concurrency & Idempotency Test passed");

  // Test 3: Tampered Ciphertext is Rejected
  console.log("Running Tamper Protection Test...");
  initDb();
  idempotencyService.clear();

  const cleanPacket = createPacket("alice@demo", "bob@demo", 500, "1234", 5);
  // Modify one character in the base64 ciphertext
  const tamperedCiphertext = cleanPacket.ciphertext.substring(0, 100) + 'X' + cleanPacket.ciphertext.substring(101);
  const tamperedPacket = { ...cleanPacket, ciphertext: tamperedCiphertext };

  const outcome = await ingest(tamperedPacket, "bridge-1", 1);
  assert.strictEqual(outcome.outcome, "INVALID");
  assert.strictEqual(outcome.reason, "decryption_failed");
  
  const aliceAfterTamper = await getAccount("alice@demo");
  assert.strictEqual(aliceAfterTamper.balance, 5000, "No funds should move for invalid packets");
  console.log("✓ Tamper Protection Test passed");

  // Test 4: Replay Protection (Stale Packet)
  console.log("Running Replay Protection Test...");
  initDb();
  idempotencyService.clear();

  // Construct a packet manually with signedAt in the past (e.g. 25 hours ago)
  const staleSignedAt = Date.now() - (25 * 60 * 60 * 1000);
  const stalePayload = {
    senderVpa: "alice@demo",
    receiverVpa: "bob@demo",
    amount: 500,
    pinHash: sha256Hex("1234"),
    nonce: "old-nonce",
    signedAt: staleSignedAt
  };
  const staleCiphertext = encrypt(stalePayload, serverKey.publicKey);
  const stalePacket = {
    packetId: "old-packet-id",
    ttl: 5,
    createdAt: Date.now(),
    ciphertext: staleCiphertext
  };

  const staleOutcome = await ingest(stalePacket, "bridge-1", 1);
  assert.strictEqual(staleOutcome.outcome, "INVALID");
  assert.strictEqual(staleOutcome.reason, "stale_packet");

  const aliceAfterStale = await getAccount("alice@demo");
  assert.strictEqual(aliceAfterStale.balance, 5000, "No funds should move for stale packets");
  console.log("✓ Replay Protection Test passed");

  console.log("\nAll tests passed successfully!");
}

runTests().catch(err => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
