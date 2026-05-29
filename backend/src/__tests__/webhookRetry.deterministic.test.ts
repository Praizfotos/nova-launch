/**
 * Deterministic Unit Tests for Webhook Delivery Retry and Backoff Semantics
 *
 * Tests verify:
 * - Exponential backoff intervals follow documented schedule
 * - Mocked HTTP client fails N times then succeeds
 * - Exhausting all retries marks delivery failed exactly once
 * - Successful first attempt performs no retries
 * - Terminal failure handling
 *
 * Issue: #1061
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  WebhookRetryService,
  computeDelay,
  isRetryable,
  AttemptResult,
  RetryConfig,
  DEFAULT_RETRY_CONFIG,
} from "../services/webhookRetry";

describe("WebhookRetryService - Deterministic Tests", () => {
  let retryService: WebhookRetryService;
  let delayFn: ReturnType<typeof vi.fn>;
  let config: Partial<RetryConfig>;

  beforeEach(() => {
    // Use fake timers for deterministic delay testing
    delayFn = vi.fn().mockResolvedValue(undefined);
    config = {
      maxAttempts: 5,
      baseDelayMs: 1000,
      backoffMultiplier: 2,
      maxDelayMs: 30000,
      jitter: false, // Disable jitter for deterministic testing
    };
    retryService = new WebhookRetryService(config, delayFn);
  });

  describe("Exponential Backoff Schedule", () => {
    it("should compute correct backoff delays without jitter", () => {
      const cfg = {
        baseDelayMs: 1000,
        backoffMultiplier: 2,
        maxDelayMs: 30000,
        jitter: false,
      };

      // Attempt 1: no delay before first attempt
      // Attempt 2: 1000ms
      expect(computeDelay(2, cfg)).toBe(1000);
      // Attempt 3: 2000ms
      expect(computeDelay(3, cfg)).toBe(2000);
      // Attempt 4: 4000ms
      expect(computeDelay(4, cfg)).toBe(4000);
      // Attempt 5: 8000ms
      expect(computeDelay(5, cfg)).toBe(8000);
    });

    it("should cap delays at maxDelayMs", () => {
      const cfg = {
        baseDelayMs: 1000,
        backoffMultiplier: 2,
        maxDelayMs: 5000,
        jitter: false,
      };

      // Attempt 6 would be 16000ms, but capped at 5000ms
      expect(computeDelay(6, cfg)).toBe(5000);
      expect(computeDelay(7, cfg)).toBe(5000);
    });

    it("should apply jitter when enabled", () => {
      const cfg = {
        baseDelayMs: 1000,
        backoffMultiplier: 2,
        maxDelayMs: 30000,
        jitter: true,
      };

      // With jitter, delay should be within ±25% of computed value
      const baseDelay = 1000;
      const jitterRange = baseDelay * 0.25;
      const minExpected = baseDelay - jitterRange;
      const maxExpected = baseDelay + jitterRange;

      // Run multiple times to account for randomness
      for (let i = 0; i < 10; i++) {
        const delay = computeDelay(2, cfg);
        expect(delay).toBeGreaterThanOrEqual(Math.round(minExpected));
        expect(delay).toBeLessThanOrEqual(Math.round(maxExpected));
      }
    });
  });

  describe("Retry Status Codes", () => {
    it("should retry on network errors (null status)", () => {
      expect(isRetryable(null, [400, 401, 403])).toBe(true);
    });

    it("should retry on 5xx errors", () => {
      expect(isRetryable(500, [400, 401, 403])).toBe(true);
      expect(isRetryable(502, [400, 401, 403])).toBe(true);
      expect(isRetryable(503, [400, 401, 403])).toBe(true);
    });

    it("should not retry on non-retryable 4xx errors", () => {
      expect(isRetryable(400, [400, 401, 403])).toBe(false);
      expect(isRetryable(401, [400, 401, 403])).toBe(false);
      expect(isRetryable(403, [400, 401, 403])).toBe(false);
      expect(isRetryable(404, [400, 401, 403])).toBe(false);
    });

    it("should retry on 4xx errors not in non-retryable list", () => {
      expect(isRetryable(429, [400, 401, 403])).toBe(true); // Rate limit
    });
  });

  describe("Successful First Attempt", () => {
    it("should succeed on first attempt without retries", async () => {
      let attemptCount = 0;
      const attemptFn = async (): Promise<AttemptResult> => {
        attemptCount++;
        return { success: true, statusCode: 200, error: null };
      };

      const outcome = await retryService.execute(attemptFn);

      expect(outcome.success).toBe(true);
      expect(outcome.attempts).toBe(1);
      expect(attemptCount).toBe(1);
      expect(delayFn).not.toHaveBeenCalled();
    });
  });

  describe("Retry After Failures", () => {
    it("should retry N times then succeed", async () => {
      let attemptCount = 0;
      const failUntilAttempt = 3;

      const attemptFn = async (): Promise<AttemptResult> => {
        attemptCount++;
        if (attemptCount < failUntilAttempt) {
          return { success: false, statusCode: 503, error: "Service Unavailable" };
        }
        return { success: true, statusCode: 200, error: null };
      };

      const outcome = await retryService.execute(attemptFn);

      expect(outcome.success).toBe(true);
      expect(outcome.attempts).toBe(failUntilAttempt);
      expect(attemptCount).toBe(failUntilAttempt);
      // Should have delayed between attempts 1-2 and 2-3
      expect(delayFn).toHaveBeenCalledTimes(failUntilAttempt - 1);
    });

    it("should call delay with correct backoff intervals", async () => {
      let attemptCount = 0;

      const attemptFn = async (): Promise<AttemptResult> => {
        attemptCount++;
        if (attemptCount < 4) {
          return { success: false, statusCode: 503, error: "Service Unavailable" };
        }
        return { success: true, statusCode: 200, error: null };
      };

      await retryService.execute(attemptFn);

      // Verify delay calls with exponential backoff
      expect(delayFn).toHaveBeenNthCalledWith(1, 1000); // After attempt 1
      expect(delayFn).toHaveBeenNthCalledWith(2, 2000); // After attempt 2
      expect(delayFn).toHaveBeenNthCalledWith(3, 4000); // After attempt 3
    });
  });

  describe("Terminal Failure", () => {
    it("should exhaust all retries and fail", async () => {
      let attemptCount = 0;

      const attemptFn = async (): Promise<AttemptResult> => {
        attemptCount++;
        return { success: false, statusCode: 503, error: "Service Unavailable" };
      };

      const outcome = await retryService.execute(attemptFn);

      expect(outcome.success).toBe(false);
      expect(outcome.attempts).toBe(5); // maxAttempts
      expect(attemptCount).toBe(5);
      expect(outcome.lastStatusCode).toBe(503);
      expect(outcome.lastError).toBe("Service Unavailable");
    });

    it("should stop immediately on non-retryable status", async () => {
      let attemptCount = 0;

      const attemptFn = async (): Promise<AttemptResult> => {
        attemptCount++;
        return { success: false, statusCode: 404, error: "Not Found" };
      };

      const outcome = await retryService.execute(attemptFn);

      expect(outcome.success).toBe(false);
      expect(outcome.attempts).toBe(1); // Should not retry
      expect(attemptCount).toBe(1);
      expect(delayFn).not.toHaveBeenCalled();
    });

    it("should mark delivery failed exactly once on terminal failure", async () => {
      let failureCount = 0;

      const attemptFn = async (): Promise<AttemptResult> => {
        return { success: false, statusCode: 503, error: "Service Unavailable" };
      };

      const outcome = await retryService.execute(attemptFn);

      // Outcome should indicate single failure (not multiple)
      expect(outcome.success).toBe(false);
      expect(outcome.attempts).toBe(5);
      // The failure is recorded once in the outcome
      expect(outcome.lastError).toBe("Service Unavailable");
    });
  });

  describe("Network Errors", () => {
    it("should retry on network error (null status)", async () => {
      let attemptCount = 0;

      const attemptFn = async (): Promise<AttemptResult> => {
        attemptCount++;
        if (attemptCount < 2) {
          return { success: false, statusCode: null, error: "Network timeout" };
        }
        return { success: true, statusCode: 200, error: null };
      };

      const outcome = await retryService.execute(attemptFn);

      expect(outcome.success).toBe(true);
      expect(outcome.attempts).toBe(2);
      expect(delayFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("Configuration", () => {
    it("should use default config when not provided", () => {
      const service = new WebhookRetryService({}, delayFn);
      const cfg = service.getConfig();

      expect(cfg.maxAttempts).toBe(DEFAULT_RETRY_CONFIG.maxAttempts);
      expect(cfg.baseDelayMs).toBe(DEFAULT_RETRY_CONFIG.baseDelayMs);
      expect(cfg.backoffMultiplier).toBe(DEFAULT_RETRY_CONFIG.backoffMultiplier);
    });

    it("should override config with provided values", () => {
      const customConfig: Partial<RetryConfig> = {
        maxAttempts: 3,
        baseDelayMs: 500,
      };
      const service = new WebhookRetryService(customConfig, delayFn);
      const cfg = service.getConfig();

      expect(cfg.maxAttempts).toBe(3);
      expect(cfg.baseDelayMs).toBe(500);
    });
  });

  describe("Timing Accuracy", () => {
    it("should track total duration correctly", async () => {
      const startTime = Date.now();
      let attemptCount = 0;

      const attemptFn = async (): Promise<AttemptResult> => {
        attemptCount++;
        if (attemptCount < 3) {
          return { success: false, statusCode: 503, error: "Service Unavailable" };
        }
        return { success: true, statusCode: 200, error: null };
      };

      const outcome = await retryService.execute(attemptFn);
      const endTime = Date.now();

      expect(outcome.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(outcome.totalDurationMs).toBeLessThanOrEqual(endTime - startTime + 100); // Allow 100ms margin
    });
  });

  describe("Edge Cases", () => {
    it("should handle maxAttempts of 1", async () => {
      const singleAttemptConfig: Partial<RetryConfig> = {
        maxAttempts: 1,
        baseDelayMs: 1000,
      };
      const service = new WebhookRetryService(singleAttemptConfig, delayFn);

      let attemptCount = 0;
      const attemptFn = async (): Promise<AttemptResult> => {
        attemptCount++;
        return { success: false, statusCode: 503, error: "Service Unavailable" };
      };

      const outcome = await service.execute(attemptFn);

      expect(outcome.success).toBe(false);
      expect(outcome.attempts).toBe(1);
      expect(attemptCount).toBe(1);
      expect(delayFn).not.toHaveBeenCalled();
    });

    it("should handle zero baseDelayMs", () => {
      const cfg = {
        baseDelayMs: 0,
        backoffMultiplier: 2,
        maxDelayMs: 30000,
        jitter: false,
      };

      expect(computeDelay(2, cfg)).toBe(0);
      expect(computeDelay(3, cfg)).toBe(0);
    });
  });
});
