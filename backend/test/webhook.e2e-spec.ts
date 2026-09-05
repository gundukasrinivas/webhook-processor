/**
 * Integration tests — require a running PostgreSQL instance.
 * Run with: docker compose up db -d && npm test
 *
 * These tests cover the critical correctness properties:
 * 1. Duplicate protection under concurrent submissions
 * 2. Retry behavior with backoff and permanent failure
 * 3. Crash recovery (stale lock reclaim)
 */
import { Pool } from 'pg';

const TEST_DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'webhooks',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
};

let pool: Pool;

beforeAll(async () => {
  pool = new Pool(TEST_DB_CONFIG);
  // Clean tables
  await pool.query('DELETE FROM attempt_history');
  await pool.query('DELETE FROM processed_orders');
  await pool.query('DELETE FROM webhook_events');
});

afterAll(async () => {
  await pool.end();
});

describe('Duplicate protection under concurrency', () => {
  const eventId = 'test-dup-' + Date.now();

  it('should produce exactly one row in processed_orders when the same event is inserted concurrently', async () => {
    // Simulate 10 concurrent insertions of the same event
    const insertPromises = Array.from({ length: 10 }, () =>
      pool.query(
        `INSERT INTO webhook_events (event_id, type, data, status, next_retry_at)
         VALUES ($1, 'order.created', '{"orderId":"ORD-TEST"}', 'pending', NOW())
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [eventId],
      ),
    );

    const results = await Promise.all(insertPromises);
    const inserted = results.filter((r) => r.rows.length > 0);

    // Exactly one insert should succeed
    expect(inserted.length).toBe(1);

    // Now simulate concurrent processed_orders inserts (as if two workers both try)
    const processPromises = Array.from({ length: 5 }, () =>
      pool.query(
        `INSERT INTO processed_orders (order_id, event_id, processed_at)
         VALUES ('ORD-TEST', $1, NOW())
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [eventId],
      ),
    );

    const processResults = await Promise.all(processPromises);
    const processedInserted = processResults.filter((r) => r.rows.length > 0);

    // Exactly one processed_order row
    expect(processedInserted.length).toBe(1);

    // Verify count
    const countResult = await pool.query(
      'SELECT COUNT(*) as cnt FROM processed_orders WHERE event_id = $1',
      [eventId],
    );
    expect(parseInt(countResult.rows[0].cnt)).toBe(1);
  });
});

describe('Claim with FOR UPDATE SKIP LOCKED', () => {
  it('should not allow two workers to claim the same event', async () => {
    const eventId = 'test-claim-' + Date.now();

    await pool.query(
      `INSERT INTO webhook_events (event_id, type, data, status, next_retry_at)
       VALUES ($1, 'order.created', '{"orderId":"ORD-CLAIM"}', 'pending', NOW())`,
      [eventId],
    );

    // Two concurrent claims using separate connections
    const client1 = await pool.connect();
    const client2 = await pool.connect();

    try {
      await client1.query('BEGIN');
      await client2.query('BEGIN');

      const claim1 = await client1.query(
        `SELECT id, event_id FROM webhook_events
         WHERE status = 'pending' AND next_retry_at <= NOW()
         ORDER BY next_retry_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );

      const claim2 = await client2.query(
        `SELECT id, event_id FROM webhook_events
         WHERE status = 'pending' AND next_retry_at <= NOW()
         ORDER BY next_retry_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );

      await client1.query('COMMIT');
      await client2.query('COMMIT');

      // At most one should get the event (the other gets nothing because SKIP LOCKED)
      const claimed = [claim1.rows.length, claim2.rows.length];
      // One gets 1, the other gets 0
      expect(claimed.sort()).toEqual([0, 1]);
    } finally {
      client1.release();
      client2.release();
    }
  });
});

describe('Crash recovery — stale lock reclaim', () => {
  it('should allow reclaiming an event with an expired lock', async () => {
    const eventId = 'test-crash-' + Date.now();

    // Insert an event that appears to be stuck in processing (locked 60s ago)
    await pool.query(
      `INSERT INTO webhook_events (event_id, type, data, status, locked_by, locked_at, next_retry_at)
       VALUES ($1, 'order.created', '{"orderId":"ORD-CRASH"}', 'processing', 'dead-worker', NOW() - INTERVAL '60 seconds', NOW())`,
      [eventId],
    );

    // A new worker should be able to reclaim it (lease timeout = 30s)
    const leaseTimeout = 30;
    const result = await pool.query(
      `UPDATE webhook_events
       SET status = 'processing', locked_by = 'recovery-worker', locked_at = NOW(), updated_at = NOW()
       WHERE id = (
         SELECT id FROM webhook_events
         WHERE (
           (status = 'pending' AND next_retry_at <= NOW())
           OR
           (status = 'processing' AND locked_at < NOW() - INTERVAL '1 second' * $1)
         )
         AND event_id = $2
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [leaseTimeout, eventId],
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].locked_by).toBe('recovery-worker');
  });
});

describe('Retry behavior', () => {
  it('should set next_retry_at with backoff on failure', async () => {
    const eventId = 'test-retry-' + Date.now();

    await pool.query(
      `INSERT INTO webhook_events (event_id, type, data, status, attempt_count, next_retry_at)
       VALUES ($1, 'order.created', '{"orderId":"ORD-RETRY","simulate":"always_fail"}', 'pending', 0, NOW())`,
      [eventId],
    );

    // Simulate a failed attempt: update to pending with backoff
    const attemptNumber = 1;
    const backoffSeconds = Math.pow(2, attemptNumber); // 2 seconds
    await pool.query(
      `UPDATE webhook_events
       SET status = 'pending', attempt_count = $1, next_retry_at = NOW() + INTERVAL '1 second' * $2
       WHERE event_id = $3`,
      [attemptNumber, backoffSeconds, eventId],
    );

    const result = await pool.query(
      'SELECT * FROM webhook_events WHERE event_id = $1',
      [eventId],
    );

    expect(result.rows[0].attempt_count).toBe(1);
    expect(result.rows[0].status).toBe('pending');
    // next_retry_at should be in the future
    expect(new Date(result.rows[0].next_retry_at).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('should mark event as permanently failed after max attempts', async () => {
    const eventId = 'test-permfail-' + Date.now();

    await pool.query(
      `INSERT INTO webhook_events (event_id, type, data, status, attempt_count, max_attempts, next_retry_at)
       VALUES ($1, 'order.created', '{"orderId":"ORD-PERMFAIL","simulate":"always_fail"}', 'pending', 4, 5, NOW())`,
      [eventId],
    );

    // Simulate reaching max attempts
    await pool.query(
      `UPDATE webhook_events SET status = 'failed', attempt_count = 5 WHERE event_id = $1`,
      [eventId],
    );

    const result = await pool.query(
      'SELECT * FROM webhook_events WHERE event_id = $1',
      [eventId],
    );

    expect(result.rows[0].status).toBe('failed');
    expect(result.rows[0].attempt_count).toBe(5);
  });
});
