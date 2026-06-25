class IdempotencyService {
  constructor(ttlSeconds = 86400) {
    this.seen = new Map();
    this.ttlSeconds = ttlSeconds;
    // Evict expired entries every 60 seconds
    this.intervalId = setInterval(() => this.evictExpired(), 60000);
  }

  /**
   * Tries to claim a packet hash.
   * In single-threaded JavaScript, the check-and-set sequence is atomic
   * because no other JS code executes concurrently.
   * Returns true if first claim; false if duplicate.
   */
  claim(packetHash) {
    const now = Date.now();
    if (this.seen.has(packetHash)) {
      return false;
    }
    this.seen.set(packetHash, now);
    return true;
  }

  size() {
    return this.seen.size;
  }

  evictExpired() {
    const cutoff = Date.now() - (this.ttlSeconds * 1000);
    for (const [hash, timestamp] of this.seen.entries()) {
      if (timestamp < cutoff) {
        this.seen.delete(hash);
      }
    }
  }

  clear() {
    this.seen.clear();
  }

  destroy() {
    clearInterval(this.intervalId);
  }
}

export const idempotencyService = new IdempotencyService();
export { IdempotencyService };
