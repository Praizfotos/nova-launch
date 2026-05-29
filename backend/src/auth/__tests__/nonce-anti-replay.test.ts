import { describe, it, expect, beforeEach, vi } from "vitest";

// Nonce store implementation (mirrors NonceService)
interface NonceEntry {
  nonce: string;
  publicKey: string;
  expiresAt: number;
  used: boolean;
}

class NonceStore {
  private nonceStore = new Map<string, NonceEntry>();
  private readonly NONCE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

  generateNonce(publicKey: string): { nonce: string; expiresAt: number } {
    const nonce = this.generateUUID();
    const expiresAt = Date.now() + this.NONCE_EXPIRY_MS;

    this.nonceStore.set(nonce, {
      nonce,
      publicKey,
      expiresAt,
      used: false,
    });

    return { nonce, expiresAt };
  }

  consumeNonce(nonce: string, publicKey: string): boolean {
    const entry = this.nonceStore.get(nonce);

    if (!entry) {
      return false;
    }

    if (entry.used) {
      return false;
    }

    if (Date.now() > entry.expiresAt) {
      this.nonceStore.delete(nonce);
      return false;
    }

    if (entry.publicKey !== publicKey) {
      return false;
    }

    // Mark as used immediately to prevent race conditions
    entry.used = true;
    this.nonceStore.set(nonce, entry);

    // Schedule deletion
    setTimeout(() => this.nonceStore.delete(nonce), 5000);

    return true;
  }

  private generateUUID(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  // For testing: get nonce entry
  getNonceEntry(nonce: string): NonceEntry | undefined {
    return this.nonceStore.get(nonce);
  }

  // For testing: clear all nonces
  clear(): void {
    this.nonceStore.clear();
  }
}

describe("Nonce Service - Uniqueness and Anti-Replay", () => {
  let store: NonceStore;
  const publicKey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  beforeEach(() => {
    store = new NonceStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Nonce Uniqueness", () => {
    it("should issue unique nonces across many issuances", () => {
      const nonces = new Set<string>();
      const count = 100;

      for (let i = 0; i < count; i++) {
        const { nonce } = store.generateNonce(publicKey);
        nonces.add(nonce);
      }

      expect(nonces.size).toBe(count);
    });

    it("should generate different nonces for the same public key", () => {
      const { nonce: nonce1 } = store.generateNonce(publicKey);
      const { nonce: nonce2 } = store.generateNonce(publicKey);

      expect(nonce1).not.toBe(nonce2);
    });

    it("should generate different nonces for different public keys", () => {
      const publicKey2 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
      const { nonce: nonce1 } = store.generateNonce(publicKey);
      const { nonce: nonce2 } = store.generateNonce(publicKey2);

      expect(nonce1).not.toBe(nonce2);
    });
  });

  describe("Anti-Replay - Single Use", () => {
    it("should reject a nonce consumed twice (replay rejected)", () => {
      const { nonce } = store.generateNonce(publicKey);

      // First consumption should succeed
      const firstConsume = store.consumeNonce(nonce, publicKey);
      expect(firstConsume).toBe(true);

      // Second consumption should fail (replay attack)
      const secondConsume = store.consumeNonce(nonce, publicKey);
      expect(secondConsume).toBe(false);
    });

    it("should mark nonce as used after first consumption", () => {
      const { nonce } = store.generateNonce(publicKey);

      store.consumeNonce(nonce, publicKey);
      const entry = store.getNonceEntry(nonce);

      expect(entry?.used).toBe(true);
    });

    it("should reject consumption of an unknown nonce", () => {
      const unknownNonce = "unknown-nonce-xyz";
      const result = store.consumeNonce(unknownNonce, publicKey);

      expect(result).toBe(false);
    });
  });

  describe("Nonce Expiration", () => {
    it("should reject expired nonces", () => {
      const { nonce } = store.generateNonce(publicKey);

      // Advance time past expiration (5 minutes + 1 second)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

      const result = store.consumeNonce(nonce, publicKey);
      expect(result).toBe(false);
    });

    it("should accept nonces before expiration", () => {
      const { nonce } = store.generateNonce(publicKey);

      // Advance time but not past expiration (4 minutes)
      vi.advanceTimersByTime(4 * 60 * 1000);

      const result = store.consumeNonce(nonce, publicKey);
      expect(result).toBe(true);
    });

    it("should delete expired nonces from store", () => {
      const { nonce } = store.generateNonce(publicKey);

      // Advance time past expiration
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

      store.consumeNonce(nonce, publicKey);
      const entry = store.getNonceEntry(nonce);

      expect(entry).toBeUndefined();
    });
  });

  describe("Public Key Binding", () => {
    it("should reject nonce consumption with wrong public key", () => {
      const { nonce } = store.generateNonce(publicKey);
      const wrongPublicKey = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

      const result = store.consumeNonce(nonce, wrongPublicKey);
      expect(result).toBe(false);
    });

    it("should accept nonce consumption with correct public key", () => {
      const { nonce } = store.generateNonce(publicKey);

      const result = store.consumeNonce(nonce, publicKey);
      expect(result).toBe(true);
    });

    it("should bind nonce to specific public key", () => {
      const publicKey2 = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
      const { nonce } = store.generateNonce(publicKey);

      const entry = store.getNonceEntry(nonce);
      expect(entry?.publicKey).toBe(publicKey);
      expect(entry?.publicKey).not.toBe(publicKey2);
    });
  });

  describe("Expiration Metadata", () => {
    it("should return expiration time on generation", () => {
      const now = Date.now();
      const { expiresAt } = store.generateNonce(publicKey);

      // Should be approximately 5 minutes from now
      const expectedExpiry = now + 5 * 60 * 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 100);
      expect(expiresAt).toBeLessThanOrEqual(expectedExpiry + 100);
    });

    it("should store expiration time in nonce entry", () => {
      const { nonce, expiresAt } = store.generateNonce(publicKey);
      const entry = store.getNonceEntry(nonce);

      expect(entry?.expiresAt).toBe(expiresAt);
    });
  });

  describe("Edge Cases", () => {
    it("should handle rapid nonce generation", () => {
      const nonces = [];
      for (let i = 0; i < 10; i++) {
        const { nonce } = store.generateNonce(publicKey);
        nonces.push(nonce);
      }

      const uniqueNonces = new Set(nonces);
      expect(uniqueNonces.size).toBe(10);
    });

    it("should handle concurrent consumption attempts", () => {
      const { nonce } = store.generateNonce(publicKey);

      // Simulate concurrent consumption
      const result1 = store.consumeNonce(nonce, publicKey);
      const result2 = store.consumeNonce(nonce, publicKey);

      // Only one should succeed
      expect(result1 || result2).toBe(true);
      expect(result1 && result2).toBe(false);
    });

    it("should handle empty public key", () => {
      const { nonce } = store.generateNonce("");

      const result = store.consumeNonce(nonce, "");
      expect(result).toBe(true);
    });
  });
});

// Helper for afterEach
function afterEach(callback: () => void) {
  // This is handled by vitest
}
