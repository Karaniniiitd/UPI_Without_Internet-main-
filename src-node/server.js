import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { serverKey } from './crypto.js';
import { createPacket } from './demo.js';
import { meshSimulator } from './mesh.js';
import { idempotencyService } from './idempotency.js';
import { ingest } from './ingestion.js';
import { getAccountsList, getTransactionsList, initDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
// Serve static frontend files from 'public' directory
app.use(express.static(path.join(__dirname, '../public')));

// -------------------------------------------------- Server Key Endpoint
app.get('/api/server-key', (req, res) => {
  // Export the SPKI public key DER format encoded in base64 to match Java
  const pubKey = crypto.createPublicKey(serverKey.publicKey);
  const der = pubKey.export({ type: 'spki', format: 'der' });
  const publicKeyBase64 = der.toString('base64');

  res.json({
    publicKey: publicKeyBase64,
    algorithm: 'RSA-2048 / OAEP-SHA256',
    hybridScheme: 'RSA-OAEP encrypts an AES-256-GCM session key'
  });
});

// -------------------------------------------------- Demo Send Endpoint
app.post('/api/demo/send', (req, res) => {
  try {
    const { senderVpa, receiverVpa, amount, pin, ttl, startDevice } = req.body;
    const packet = createPacket(
      senderVpa,
      receiverVpa,
      amount,
      pin,
      ttl === undefined ? 5 : ttl
    );

    const targetDevice = startDevice || 'phone-alice';
    meshSimulator.inject(targetDevice, packet);

    res.json({
      packetId: packet.packetId,
      ciphertextPreview: packet.ciphertext.substring(0, 64) + '...',
      ttl: packet.ttl,
      injectedAt: targetDevice
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------- Mesh Simulator Endpoints
app.get('/api/mesh/state', (req, res) => {
  const deviceData = meshSimulator.getDevices().map(d => ({
    deviceId: d.deviceId,
    hasInternet: d.hasInternet,
    packetCount: d.packetCount(),
    packetIds: d.getHeldPackets().map(p => p.packetId.substring(0, 8))
  }));

  res.json({
    devices: deviceData,
    idempotencyCacheSize: idempotencyService.size()
  });
});

app.post('/api/mesh/gossip', (req, res) => {
  const result = meshSimulator.gossipOnce();
  res.json(result);
});

app.post('/api/mesh/flush', async (req, res) => {
  try {
    const uploads = meshSimulator.collectBridgeUploads();
    
    // Process uploads in parallel to simulate concurrent bridge ingestion
    const results = await Promise.all(
      uploads.map(async (up) => {
        const ingestResult = await ingest(up.packet, up.bridgeNodeId, 5 - up.packet.ttl);
        return {
          bridgeNode: up.bridgeNodeId,
          packetId: up.packet.packetId.substring(0, 8),
          outcome: ingestResult.outcome,
          reason: ingestResult.reason || '',
          transactionId: ingestResult.transactionId !== null ? ingestResult.transactionId : -1
        };
      })
    );

    res.json({
      uploadsAttempted: uploads.length,
      results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/mesh/reset', (req, res) => {
  meshSimulator.resetMesh();
  idempotencyService.clear();
  initDb();
  res.json({ status: 'mesh and idempotency cache cleared' });
});

// -------------------------------------------------- Bridge Production Endpoint
app.post('/api/bridge/ingest', async (req, res) => {
  try {
    const packet = req.body;
    const bridgeNodeId = req.headers['x-bridge-node-id'] || 'unknown';
    const hopCount = parseInt(req.headers['x-hop-count'] || '0', 10);

    const result = await ingest(packet, bridgeNodeId, hopCount);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// -------------------------------------------------- Dashboard Ledger Endpoints
app.get('/api/accounts', (req, res) => {
  res.json(getAccountsList());
});

app.get('/api/transactions', (req, res) => {
  res.json(getTransactionsList());
});

// Start listening
app.listen(PORT, () => {
  console.log(`Server started at http://localhost:${PORT}`);
});
