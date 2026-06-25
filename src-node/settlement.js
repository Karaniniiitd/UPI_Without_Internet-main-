import { getAccount, saveAccount, saveTransaction } from './db.js';

/**
 * Settles a payment instruction.
 *
 * Implements a simulated atomic transaction:
 * 1. Checks balances.
 * 2. Updates sender and receiver balances in memory.
 * 3. Commits modifications to the database layer (db.js) which triggers optimistic locking version checks.
 * 4. Logs the transaction outcome.
 */
export async function settle(instruction, packetHash, bridgeNodeId, hopCount) {
  const senderSnapshot = await getAccount(instruction.senderVpa);
  if (!senderSnapshot) {
    throw new Error(`Unknown sender VPA: ${instruction.senderVpa}`);
  }

  const receiverSnapshot = await getAccount(instruction.receiverVpa);
  if (!receiverSnapshot) {
    throw new Error(`Unknown receiver VPA: ${instruction.receiverVpa}`);
  }

  const amount = Number(instruction.amount);
  if (amount <= 0) {
    throw new Error('Amount must be positive');
  }

  if (senderSnapshot.balance < amount) {
    console.warn(`Insufficient balance: ${senderSnapshot.vpa} has ₹${senderSnapshot.balance}, tried to send ₹${amount}`);
    
    const tx = {
      packetHash,
      senderVpa: instruction.senderVpa,
      receiverVpa: instruction.receiverVpa,
      amount,
      signedAt: new Date(instruction.signedAt).toISOString(),
      settledAt: new Date().toISOString(),
      bridgeNodeId,
      hopCount,
      status: 'REJECTED'
    };
    return await saveTransaction(tx);
  }

  // Deduct/credit snapshots
  senderSnapshot.balance -= amount;
  receiverSnapshot.balance += amount;

  // Persist both snapshots (if a version collision occurs, one of these will throw)
  await saveAccount(senderSnapshot);
  try {
    await saveAccount(receiverSnapshot);
  } catch (error) {
    // Rollback sender snapshot if receiver fails (simulating transactional rollback)
    const originalSender = await getAccount(instruction.senderVpa);
    if (originalSender) {
      originalSender.balance += amount;
      // Force write back by resetting version
      originalSender.version = senderSnapshot.version + 1;
      await saveAccount(originalSender);
    }
    throw error;
  }

  // Create settled transaction ledger entry
  const tx = {
    packetHash,
    senderVpa: instruction.senderVpa,
    receiverVpa: instruction.receiverVpa,
    amount,
    signedAt: new Date(instruction.signedAt).toISOString(),
    settledAt: new Date().toISOString(),
    bridgeNodeId,
    hopCount,
    status: 'SETTLED'
  };

  console.log(`SETTLED ₹${amount} from ${instruction.senderVpa} to ${instruction.receiverVpa} (packetHash=${packetHash.substring(0, 12)}..., bridge=${bridgeNodeId}, hops=${hopCount})`);
  return await saveTransaction(tx);
}
