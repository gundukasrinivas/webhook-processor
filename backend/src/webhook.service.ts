import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from './database.service';

export interface WebhookEvent {
  eventId: string;
  type: string;
  data: Record<string, any>;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Persist incoming webhook event. Uses ON CONFLICT to handle duplicates
   * at the ingestion level — the same eventId submitted multiple times
   * just returns the existing row.
   */
  async ingest(event: WebhookEvent): Promise<{ id: number; duplicate: boolean }> {
    const result = await this.db.query(
      `INSERT INTO webhook_events (event_id, type, data, status, next_retry_at)
       VALUES ($1, $2, $3, 'pending', NOW())
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [event.eventId, event.type, JSON.stringify(event.data)],
    );

    if (result.rows.length === 0) {
      // Already exists
      const existing = await this.db.query(
        'SELECT id FROM webhook_events WHERE event_id = $1',
        [event.eventId],
      );
      return { id: existing.rows[0].id, duplicate: true };
    }

    return { id: result.rows[0].id, duplicate: false };
  }

  /**
   * Claim the next available event for processing.
   * Uses FOR UPDATE SKIP LOCKED to ensure only one worker gets each event.
   * Also reclaims events stuck in 'processing' for > LEASE_TIMEOUT seconds
   * (crash recovery).
   */
  async claimEvent(workerId: string): Promise<any | null> {
    const leaseTimeout = parseInt(process.env.LEASE_TIMEOUT_SECONDS || '30');
    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE webhook_events
         SET status = 'processing',
             locked_by = $1,
             locked_at = NOW(),
             updated_at = NOW()
         WHERE id = (
           SELECT id FROM webhook_events
           WHERE (
             (status = 'pending' AND next_retry_at <= NOW())
             OR
             (status = 'processing' AND locked_at < NOW() - INTERVAL '1 second' * $2)
           )
           ORDER BY next_retry_at ASC NULLS LAST
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`,
        [workerId, leaseTimeout],
      );

      await client.query('COMMIT');

      if (result.rows.length === 0) return null;
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Process a claimed event. The simulate field controls behavior.
   * On success, inserts into processed_orders within a transaction
   * that also marks the event completed — ensuring atomicity.
   */
  async processEvent(event: any, workerId: string): Promise<void> {
    const attemptNumber = event.attempt_count + 1;
    const startedAt = new Date();
    const leaseHeartbeat = this.startLeaseHeartbeat(event.id, workerId);

    try {
      // Simulate behavior based on data.simulate field
      try {
        await this.simulateProcessing(event, attemptNumber);
      } finally {
        clearInterval(leaseHeartbeat);
      }

      // Success path: use a transaction to atomically mark completed + insert processed_order
      const client = await this.db.getClient();
      try {
        await client.query('BEGIN');

        const completed = await client.query(
          `UPDATE webhook_events
           SET status = 'completed', attempt_count = $1, locked_by = NULL, locked_at = NULL, updated_at = NOW()
           WHERE id = $2 AND status = 'processing' AND locked_by = $3
           RETURNING id`,
          [attemptNumber, event.id, workerId],
        );

        if (completed.rows.length === 0) {
          await client.query('ROLLBACK');
          return;
        }

        await client.query(
          `INSERT INTO processed_orders (order_id, event_id, processed_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (event_id) DO NOTHING`,
          [event.data?.orderId || event.event_id, event.event_id],
        );

        // Record successful attempt
        await client.query(
          `INSERT INTO attempt_history (event_id, attempt_number, worker_id, started_at, finished_at, result)
           VALUES ($1, $2, $3, $4, NOW(), 'success')`,
          [event.event_id, attemptNumber, workerId, startedAt],
        );

        await client.query('COMMIT');
        this.logger.log(`Event ${event.event_id} processed successfully by ${workerId}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      // Failure path
      await this.handleFailure(event, attemptNumber, workerId, startedAt, err);
    }
  }

  private startLeaseHeartbeat(eventId: number, workerId: string): NodeJS.Timeout {
    const leaseTimeout = parseInt(process.env.LEASE_TIMEOUT_SECONDS || '30', 10);
    const intervalMs = Math.max(250, Math.floor((leaseTimeout * 1000) / 3));
    return setInterval(() => {
      void this.db
        .query(
          `UPDATE webhook_events
           SET locked_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
          [eventId, workerId],
        )
        .catch((error) => this.logger.warn(`Failed to renew lease for event ${eventId}: ${error.message}`));
    }, intervalMs);
  }

  private async simulateProcessing(event: any, attemptNumber: number): Promise<void> {
    const simulate = event.data?.simulate || 'ok';

    if (simulate === 'ok' || simulate === '') {
      return;
    }

    if (simulate === 'always_fail') {
      throw new Error('Simulated permanent failure');
    }

    const failMatch = simulate.match(/^fail_then_succeed:(\d+)$/);
    if (failMatch) {
      const failCount = parseInt(failMatch[1]);
      if (attemptNumber <= failCount) {
        throw new Error(`Simulated failure (attempt ${attemptNumber} of ${failCount} failures)`);
      }
      return;
    }

    const slowMatch = simulate.match(/^slow:(\d+)$/);
    if (slowMatch) {
      const seconds = parseInt(slowMatch[1]);
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return;
    }

    // Unknown simulate value — treat as ok
    return;
  }

  private async handleFailure(
    event: any,
    attemptNumber: number,
    workerId: string,
    startedAt: Date,
    error: any,
  ): Promise<void> {
    const configuredMaxAttempts = parseInt(process.env.MAX_ATTEMPTS || '', 10);
    const maxAttempts = configuredMaxAttempts > 0 ? configuredMaxAttempts : event.max_attempts || 5;
    const errorMessage = error?.message || String(error);
    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      if (attemptNumber >= maxAttempts) {
        const failed = await client.query(
          `UPDATE webhook_events
           SET status = 'failed', attempt_count = $1, locked_by = NULL, locked_at = NULL, updated_at = NOW()
           WHERE id = $2 AND status = 'processing' AND locked_by = $3
           RETURNING id`,
          [attemptNumber, event.id, workerId],
        );
        if (failed.rows.length === 0) {
          await client.query('ROLLBACK');
          return;
        }
        this.logger.warn(`Event ${event.event_id} permanently failed after ${attemptNumber} attempts`);
      } else {
        const backoffSeconds = Math.pow(2, attemptNumber);
        const retried = await client.query(
          `UPDATE webhook_events
           SET status = 'pending',
               attempt_count = $1,
               locked_by = NULL,
               locked_at = NULL,
               next_retry_at = NOW() + INTERVAL '1 second' * $2,
               updated_at = NOW()
           WHERE id = $3 AND status = 'processing' AND locked_by = $4
           RETURNING id`,
          [attemptNumber, backoffSeconds, event.id, workerId],
        );
        if (retried.rows.length === 0) {
          await client.query('ROLLBACK');
          return;
        }
        this.logger.log(`Event ${event.event_id} failed, retry in ${backoffSeconds}s`);
      }

      await client.query(
        `INSERT INTO attempt_history (event_id, attempt_number, worker_id, started_at, finished_at, result, error)
         VALUES ($1, $2, $3, $4, NOW(), 'failure', $5)`,
        [event.event_id, attemptNumber, workerId, startedAt, errorMessage],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Manual retry: reset a permanently failed event back to pending.
   */
  async manualRetry(eventId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE webhook_events
       SET status = 'pending',
           attempt_count = 0,
           next_retry_at = NOW(),
           locked_by = NULL,
           locked_at = NULL,
           updated_at = NOW()
       WHERE event_id = $1 AND status = 'failed'
       RETURNING id`,
      [eventId],
    );
    return result.rows.length > 0;
  }

  /**
   * Get all events with their attempt counts for the operations page.
   */
  async getEvents(): Promise<any[]> {
    const result = await this.db.query(
      `SELECT e.*,
              (SELECT COUNT(*) FROM processed_orders po WHERE po.event_id = e.event_id) as has_processed_order
       FROM webhook_events e
       ORDER BY e.created_at DESC
       LIMIT 200`,
    );
    return result.rows;
  }

  /**
   * Get attempt history for a specific event.
   */
  async getAttemptHistory(eventId: string): Promise<any[]> {
    const result = await this.db.query(
      `SELECT * FROM attempt_history WHERE event_id = $1 ORDER BY attempt_number ASC`,
      [eventId],
    );
    return result.rows;
  }

  /**
   * Get a single event by eventId.
   */
  async getEvent(eventId: string): Promise<any | null> {
    const result = await this.db.query(
      'SELECT * FROM webhook_events WHERE event_id = $1',
      [eventId],
    );
    return result.rows[0] || null;
  }

  /**
   * Get stats for the operations page.
   */
  async getStats(): Promise<any> {
    const result = await this.db.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status = 'pending') as pending,
         COUNT(*) FILTER (WHERE status = 'processing') as processing,
         COUNT(*) FILTER (WHERE status = 'completed') as completed,
         COUNT(*) FILTER (WHERE status = 'failed') as failed
       FROM webhook_events`,
    );
    return result.rows[0];
  }

  /**
   * Get processed orders count.
   */
  async getProcessedOrdersCount(): Promise<number> {
    const result = await this.db.query('SELECT COUNT(*) as count FROM processed_orders');
    return parseInt(result.rows[0].count);
  }
}
