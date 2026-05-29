import { v4 as uuidv4 } from "uuid";
import db from "../database/db";
import { WebhookEventType } from "../types/webhook";

export interface DeadLetterEntry {
  id: string;
  subscriptionId: string;
  event: WebhookEventType;
  payload: string;
  statusCode: number | null;
  lastError: string | null;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

export class WebhookDeadLetterService {
  /**
   * Store a failed delivery in the dead-letter queue
   */
  async storeDeadLetter(
    subscriptionId: string,
    event: WebhookEventType,
    payload: any,
    statusCode: number | null,
    lastError: string | null,
    attemptCount: number
  ): Promise<string> {
    const id = uuidv4();
    const query = `
      INSERT INTO webhook_dead_letters
        (id, subscription_id, event, payload, status_code, last_error, attempt_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `;

    const result = await db.query(query, [
      id,
      subscriptionId,
      event,
      JSON.stringify(payload),
      statusCode,
      lastError,
      attemptCount,
    ]);

    return result.rows[0].id;
  }

  /**
   * List unresolved dead-letter entries for a subscription
   */
  async listUnresolved(
    subscriptionId: string,
    limit: number = 50
  ): Promise<DeadLetterEntry[]> {
    const query = `
      SELECT * FROM webhook_dead_letters
      WHERE subscription_id = $1 AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT $2
    `;

    const result = await db.query(query, [subscriptionId, limit]);
    return result.rows.map(this.mapRowToEntry);
  }

  /**
   * Get a specific dead-letter entry by ID
   */
  async getEntry(id: string): Promise<DeadLetterEntry | null> {
    const query = `
      SELECT * FROM webhook_dead_letters WHERE id = $1
    `;

    const result = await db.query(query, [id]);
    if (result.rows.length === 0) return null;
    return this.mapRowToEntry(result.rows[0]);
  }

  /**
   * Mark a dead-letter entry as resolved (retried/skipped/etc)
   */
  async markResolved(
    id: string,
    resolution: "retried" | "skipped" | "archived"
  ): Promise<boolean> {
    const query = `
      UPDATE webhook_dead_letters
      SET resolved_at = CURRENT_TIMESTAMP, resolution = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id
    `;

    const result = await db.query(query, [resolution, id]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Map database row to DeadLetterEntry
   */
  private mapRowToEntry(row: any): DeadLetterEntry {
    return {
      id: row.id,
      subscriptionId: row.subscription_id,
      event: row.event,
      payload: row.payload,
      statusCode: row.status_code,
      lastError: row.last_error,
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      resolution: row.resolution,
    };
  }
}

export default new WebhookDeadLetterService();
