/**
 * Audit-log retention policy enforcement.
 *
 * Purges in-memory audit log entries older than AUDIT_RETENTION_DAYS
 * (default 90 days). The job runs on a configurable interval and is
 * idempotent — re-running it on the same dataset produces the same result.
 *
 * Configuration (env vars):
 *   AUDIT_RETENTION_DAYS    – how many days to keep logs (default: 90)
 *   AUDIT_RETENTION_INTERVAL_MS – how often the job runs in ms (default: 3600000 = 1 h)
 */

import { Database } from "../config/database";
import { MetricsCollector } from "../lib/metrics";

const RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS ?? "90", 10);
const INTERVAL_MS = parseInt(
  process.env.AUDIT_RETENTION_INTERVAL_MS ?? String(60 * 60 * 1000),
  10
);

let _timer: ReturnType<typeof setInterval> | null = null;

/**
 * Purge audit log entries older than `retentionDays` days.
 * Returns the count of entries removed.
 */
export async function runAuditRetention(retentionDays = RETENTION_DAYS): Promise<number> {
  const start = Date.now();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const allLogs = await Database.getAuditLogs();
  const toRemove = allLogs.filter((l) => l.timestamp < cutoff);

  if (toRemove.length > 0) {
    await Database.purgeAuditLogs(cutoff);
  }

  const durationSeconds = (Date.now() - start) / 1000;
  const status = "success";
  MetricsCollector.recordBackgroundJob("audit_retention", status, durationSeconds);

  console.log(
    JSON.stringify({
      event: "audit_retention.complete",
      cutoff: cutoff.toISOString(),
      retentionDays,
      purged: toRemove.length,
      durationMs: Date.now() - start,
    })
  );

  return toRemove.length;
}

/** Start the scheduled retention job. Calling this more than once is a no-op. */
export function startAuditRetentionJob(): void {
  if (_timer !== null) return;

  console.log(
    JSON.stringify({
      event: "audit_retention.started",
      retentionDays: RETENTION_DAYS,
      intervalMs: INTERVAL_MS,
    })
  );

  // Run immediately on startup, then on the configured interval.
  runAuditRetention().catch((err) =>
    console.error("audit_retention initial run failed", err)
  );

  _timer = setInterval(() => {
    runAuditRetention().catch((err) =>
      console.error("audit_retention job failed", err)
    );
  }, INTERVAL_MS);

  // Don't block process exit.
  if (_timer.unref) _timer.unref();
}

/** Stop the scheduled job (primarily for tests). */
export function stopAuditRetentionJob(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
}
