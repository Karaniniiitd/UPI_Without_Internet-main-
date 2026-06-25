# UPI Offline Mesh

A Node.js/Express backend that demonstrates offline UPI payments routed through a Bluetooth-style mesh network. You are in a basement with zero connectivity. You send your friend Rs. 500. Your phone encrypts the payment, broadcasts it to nearby phones, and the packet hops device-to-device until some phone walks outside, gets 4G, and silently uploads it to this backend. The backend decrypts, deduplicates, and settles.

This repository is the server side of that system, plus a software simulator of the mesh so you can demo the whole flow on a single laptop without any real Bluetooth hardware.

---

## Table of Contents

1. [What this demo proves](#what-this-demo-proves)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [How to Run](#how-to-run)
5. [The Demo Flow](#the-demo-flow)
6. [Architecture](#architecture)
7. [The Three Hard Problems and How They Are Solved](#the-three-hard-problems-and-how-they-are-solved)
8. [API Reference](#api-reference)
9. [Tests](#tests)
10. [Honest Limitations of the Concept](#honest-limitations-of-the-concept)

---

## What this demo proves

The system shows three things working end to end:

1. A payment can travel from sender to backend through untrusted intermediaries without any of them being able to read or tamper with it. (Hybrid RSA-OAEP + AES-256-GCM encryption.)
2. Even if the same payment reaches the backend simultaneously through multiple bridge nodes, it settles exactly once. (Idempotency via atomic compare-and-set on the ciphertext hash.)
3. A tampered or replayed packet is rejected before it touches the ledger.

You will see all three in the dashboard.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ES Modules) |
| Web framework | Express 4.x |
| Cryptography | Node.js built-in `crypto` module |
| Database | In-memory JavaScript Map (zero setup) |
| ID generation | `uuid` |
| Frontend | Plain HTML + Vanilla JavaScript |
| Testing | Plain Node.js script (no framework needed) |

No database installation. No Java. No Maven. Just Node.js.

---

## Project Structure

```
upi-offline-mesh/
|
+-- src-node/               Core server modules
|   +-- server.js           Express app, all route definitions
|   +-- crypto.js           Hybrid RSA-OAEP + AES-256-GCM encrypt/decrypt
|   +-- demo.js             Simulates a sender phone building an encrypted packet
|   +-- mesh.js             VirtualDevice + MeshSimulatorService (gossip protocol)
|   +-- idempotency.js      Atomic claim via Map (in-memory SETNX equivalent)
|   +-- ingestion.js        Pipeline: hash -> claim -> decrypt -> freshness -> settle
|   +-- settlement.js       Debit/credit logic and in-memory ledger
|   +-- db.js               In-memory account and transaction store
|
+-- public/
|   +-- index.html          Interactive demo dashboard (served as static file)
|
+-- tests/
|   +-- concurrency.js      Concurrent bridge delivery test
|
+-- package.json
+-- .gitignore
+-- README.md
```

---

## How to Run

### Prerequisites

- Node.js 18 or newer. Check with `node -v`.
- That is it. No database, no Java, no build step.

### Install dependencies

```bash
npm install
```

### Start the server

```bash
npm start
```

You will see:

```
Server started at http://localhost:8080
```

### Open the dashboard

Navigate to [http://localhost:8080](http://localhost:8080) in your browser. You will get a dark interactive dashboard with everything you need to drive the demo.

### Stop the server

`Ctrl+C` in the terminal.

### Run the tests

```bash
npm test
```

---

## The Demo Flow

The dashboard has four actions that walk through the full pipeline in sequence.

### Step 1 — Compose a payment

Choose sender, receiver, amount, and PIN. Click **Inject into Mesh**.

What actually happens on the backend:
- The server simulates the sender phone.
- It builds a `PaymentInstruction` with a unique nonce and current timestamp.
- It encrypts that with the server RSA public key using hybrid encryption.
- It wraps the ciphertext in a `MeshPacket` with a TTL of 5.
- It hands the packet to `phone-alice`, an offline virtual device.

You will see `phone-alice` now holds 1 packet.

### Step 2 — Run gossip rounds

Click **Run Gossip Round**. Then click it again.

Each round, every device that holds a packet broadcasts it to every other device within Bluetooth range (which, in the simulator, means everyone). TTL decrements per hop.

After 1 round: every device holds the packet. After 2 rounds: still every device with a lower TTL.

### Step 3 — Bridge node walks outside

Click **Bridges Upload to Backend**.

`phone-bridge` is the only device with `hasInternet = true`. The dashboard simulates that phone walking outside and getting mobile data. It POSTs every packet it holds to `/api/bridge/ingest`.

The backend pipeline runs:
1. Hash the ciphertext (SHA-256).
2. Try to claim the hash in the idempotency store.
3. If claimed: decrypt with the server RSA private key.
4. Verify freshness (`signedAt` within 24 hours).
5. Debit sender and credit receiver in the in-memory ledger.

Watch the account balances update and a new row appear in the transaction ledger.

### Step 4 — Demonstrate idempotency

The real power: inject one packet, run gossip, then trigger multiple bridges uploading the same packet simultaneously. No matter how many bridges deliver the same packet at the same time, it settles exactly once. All subsequent deliveries are returned as `DUPLICATE_DROPPED`.

Run the concurrency test to see this asserted programmatically:

```bash
npm test
```

---

## Architecture

```
+-------------------------------------------------------------------------+
|                         SENDER PHONE (offline)                          |
|  PaymentInstruction { sender, receiver, amount, pinHash, nonce, time }  |
|              |                                                          |
|              v  encrypt with server RSA public key                      |
|   MeshPacket { packetId, ttl, createdAt, ciphertext }                   |
+--------------------------------------+----------------------------------+
                                       | Bluetooth gossip
                                       v
        +---------+  hop   +---------+  hop   +---------+
        |stranger1| -----> |stranger2| -----> | bridge  | <-- walks outside
        +---------+        +---------+        +----+----+     gets 4G
                                                   |
                                                   v  HTTPS POST
+-------------------------------------------------------------------------+
|                      NODE.JS EXPRESS BACKEND (this project)             |
|                                                                         |
|  /api/bridge/ingest                                                     |
|       |                                                                 |
|       v                                                                 |
|  [1] hashCiphertext(ciphertext)  -- SHA-256                             |
|       |                                                                 |
|       v                                                                 |
|  [2] idempotencyService.claim(hash)  -- Map.set (atomic-style SETNX)   |
|       |          Duplicates rejected here, before any work.             |
|       v                                                                 |
|  [3] decrypt(ciphertext)                                                |
|       |  RSA-OAEP unwraps AES key, AES-256-GCM decrypts payload        |
|       |  and verifies the auth tag. Tampering throws an exception.      |
|       v                                                                 |
|  [4] Freshness check: signedAt within last 24 hours                     |
|       |                                                                 |
|       v                                                                 |
|  [5] settle() -- debit sender, credit receiver, write ledger            |
+-------------------------------------------------------------------------+
```

---

## The Three Hard Problems and How They Are Solved

### Problem 1: Untrusted intermediates

A random stranger phone is carrying your transaction. How do you stop them from reading the amount or changing it?

**Solution: Hybrid encryption (RSA-OAEP + AES-256-GCM).**

The sender encrypts the payload with the server public key. Only the server holds the private key, so intermediates see opaque ciphertext.

Because RSA can only encrypt small data, the standard hybrid pattern is used:

1. Generate a fresh AES-256 key for this packet.
2. Encrypt the JSON with AES-256-GCM (fast and authenticated).
3. Encrypt just the AES key with RSA-OAEP.
4. Concatenate: `[256 bytes RSA-encrypted AES key][12 bytes IV][AES ciphertext + 16-byte GCM tag]`.

GCM is authenticated encryption. If an intermediate flips one bit anywhere in the ciphertext, decryption throws an exception. The GCM tag will not verify. The server cannot be tricked into processing tampered data.

See [src-node/crypto.js](src-node/crypto.js).

### Problem 2: The duplicate storm

Three bridge nodes hold the same packet. They all walk outside at the same instant. They all POST to `/api/bridge/ingest` within milliseconds of each other. If you naively process all three, the sender is debited Rs. 1500 instead of Rs. 500.

**Solution: Atomic claim on the ciphertext hash.**

The very first thing the server does on receiving a packet is compute `SHA-256(ciphertext)` and attempt to claim that hash:

```js
// idempotency.js
claim(hash) {
  if (this.seen.has(hash)) return false;
  this.seen.set(hash, Date.now());
  return true;
}
```

Only the first caller for a given hash returns `true` and proceeds to decrypt and settle. All subsequent callers return `false` and are short-circuited as `DUPLICATE_DROPPED`.

In production this in-memory Map becomes Redis: `SET key NX EX 86400`. Same semantics, distributed across replicas.

See [src-node/idempotency.js](src-node/idempotency.js).

### Problem 3: Replay attacks

An attacker who captured a ciphertext could replay it whenever convenient.

**Solution: Two layers.**

1. Inside the encrypted payload, the sender includes `signedAt` (epoch milliseconds). The server rejects any packet older than 24 hours. The attacker cannot change `signedAt` without breaking the GCM tag.
2. Inside the encrypted payload, the sender includes a nonce (UUID). Even if Alice legitimately sends Bob Rs. 100 twice, the nonces differ, the ciphertexts differ, the hashes differ, and both settle. But a replay of one specific signed packet is byte-identical, so the idempotency store catches it.

See [src-node/ingestion.js](src-node/ingestion.js).

---

## API Reference

| Method | Path | Description |
|---|---|---|
| GET | `/` | Interactive demo dashboard |
| GET | `/api/server-key` | Server RSA public key (base64) |
| GET | `/api/accounts` | All accounts and balances |
| GET | `/api/transactions` | Last 20 settled transactions |
| GET | `/api/mesh/state` | Current packet count on every virtual device |
| POST | `/api/demo/send` | Simulate a sender phone: encrypt and inject a packet |
| POST | `/api/mesh/gossip` | Run one round of gossip across all virtual devices |
| POST | `/api/mesh/flush` | Bridge devices with internet upload to backend (parallel) |
| POST | `/api/mesh/reset` | Clear mesh state and idempotency cache |
| POST | `/api/bridge/ingest` | Production endpoint. Real bridge nodes POST here |

### Request format for `/api/bridge/ingest`

```http
POST /api/bridge/ingest
Content-Type: application/json
X-Bridge-Node-Id: phone-bridge-42
X-Hop-Count: 3

{
  "packetId": "550e8400-e29b-41d4-a716-446655440000",
  "ttl": 2,
  "createdAt": 1730000000000,
  "ciphertext": "base64-encoded-RSA-and-AES-blob"
}
```

Response:

```json
{
  "outcome": "SETTLED",
  "packetHash": "a3f8c9...",
  "reason": null,
  "transactionId": 42
}
```

Possible outcome values: `SETTLED`, `DUPLICATE_DROPPED`, `INVALID`.

### Request format for `/api/demo/send`

```json
{
  "senderVpa": "alice@upi",
  "receiverVpa": "bob@upi",
  "amount": 500,
  "pin": "1234",
  "ttl": 5
}
```

---

## Tests

```bash
npm test
```

The concurrency test fires three async calls to the ingestion pipeline with the same encrypted packet simultaneously and asserts:

- Exactly one outcome is `SETTLED`.
- All remaining outcomes are `DUPLICATE_DROPPED`.
- The sender account balance changes by exactly the payment amount once.

See [tests/concurrency.js](tests/concurrency.js).

---

## Honest Limitations of the Concept

1. **The receiver has no way to verify the sender has the funds offline.** When the sender hands the receiver a phone showing "Rs. 500 sent," it is an IOU, not a settled payment. If the sender account is empty when the packet finally reaches the backend, the settlement will be rejected. This is why real offline UPI (UPI Lite) uses a pre-funded hardware-backed wallet to give cryptographic proof of available funds offline.

2. **A malicious sender can double-spend offline.** With Rs. 500 in their account, they could send a packet to Bob in one location, then send another Rs. 500 to Carol in a different location. Whichever packet hits the backend first wins; the other gets rejected.

3. **Bluetooth in real life is hard.** Background BLE on Android is heavily throttled since Android 8. iOS peripheral mode is locked down. This demo skips that problem entirely by simulating the mesh in software.

4. **Privacy.** A stranger carries your encrypted transaction packet on their phone. They cannot read it, but its existence is metadata. A real deployment would need regulatory disclosures.

For a college or portfolio project: name the concept honestly as **mesh-routed deferred settlement** rather than real-time offline UPI, and you will have a much stronger pitch. The cryptography and idempotency work here is real engineering and worth showing off.

---

## License

Demo code. Use it however you want for learning.
