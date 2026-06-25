class Account {
  constructor(vpa, holderName, balance) {
    this.vpa = vpa;
    this.holderName = holderName;
    this.balance = Number(balance);
    this.version = 0;
  }
}

let accounts = new Map();
let transactions = [];
let nextTxId = 1;

export function initDb() {
  accounts.clear();
  transactions = [];
  nextTxId = 1;
  accounts.set('alice@demo', new Account('alice@demo', 'Alice', 5000.00));
  accounts.set('bob@demo', new Account('bob@demo', 'Bob', 1000.00));
  accounts.set('carol@demo', new Account('carol@demo', 'Carol', 2500.00));
  accounts.set('dave@demo', new Account('dave@demo', 'Dave', 500.00));
}

// Initialize on startup
initDb();

/**
 * Retrieves a snapshot of an account.
 * Simulates minor DB read latency to allow concurrency testing.
 */
export async function getAccount(vpa) {
  await new Promise(resolve => setTimeout(resolve, 10));
  const acc = accounts.get(vpa);
  if (!acc) return null;
  // Return a cloned copy so the caller cannot modify the in-memory DB without saving
  return { ...acc };
}

/**
 * Saves an account with an optimistic locking version check.
 * Throws an OptimisticLockException if the version has changed.
 */
export async function saveAccount(accountSnapshot) {
  await new Promise(resolve => setTimeout(resolve, 10));
  const current = accounts.get(accountSnapshot.vpa);
  if (!current) {
    throw new Error(`Account not found: ${accountSnapshot.vpa}`);
  }
  if (current.version !== accountSnapshot.version) {
    const err = new Error('OptimisticLockException: Account was updated by another transaction');
    err.name = 'OptimisticLockException';
    throw err;
  }
  current.balance = Number(accountSnapshot.balance);
  current.version += 1;
}

/**
 * Saves a transaction to the ledger.
 */
export async function saveTransaction(tx) {
  await new Promise(resolve => setTimeout(resolve, 10));
  tx.id = nextTxId++;
  transactions.push(tx);
  return tx;
}

/**
 * Returns all accounts as a list.
 */
export function getAccountsList() {
  return Array.from(accounts.values()).map(a => ({ ...a }));
}

/**
 * Returns the latest 20 transactions.
 */
export function getTransactionsList() {
  return [...transactions].reverse().slice(0, 20);
}
