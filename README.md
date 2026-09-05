# Reliable Webhook Processor

A service that receives webhook events and processes them reliably using background workers.

## Quick Start

```bash
docker compose up --build
```

This starts:
- **PostgreSQL** on port 5432
- **API server** (NestJS) on port 3001
- **Worker 1** and **Worker 2** (background processors)
- **Frontend** (Next.js) on port 3000

Open http://localhost:3000 for the operations dashboard.

## Architecture

```
                    ┌──────────────┐
  POST /webhooks ──>│   API Server │──> webhook_events table (status=pending)
                    └──────────────┘
                           │
                    ┌──────┴──────┐
                    │  PostgreSQL  │
                    └──────┬──────┘
                     ┌─────┴─────┐
                     │           │
               ┌─────┴──┐  ┌────┴───┐
               │Worker 1 │  │Worker 2│   (poll with FOR UPDATE SKIP LOCKED)
               └─────┬──┘  └────┬───┘
                     │           │
                     └─────┬─────┘
                           │
                    processed_orders (exactly one row per event)
```

### How events move through the system

1. **Ingestion**: `POST /webhooks` persists the event to `webhook_events` with `status=pending` before returning `202 Accepted`. Uses `ON CONFLICT (event_id) DO NOTHING` for idempotent ingestion.

2. **Claiming**: Workers poll for available events using:
   ```sql
   SELECT ... FROM webhook_events
   WHERE (status = 'pending' AND next_retry_at <= NOW())
      OR (status = 'processing' AND locked_at < NOW() - lease_timeout)
   FOR UPDATE SKIP LOCKED
   LIMIT 1
   ```
   `FOR UPDATE SKIP LOCKED` ensures two workers never claim the same event.

3. **Processing**: The worker simulates the business action, then within a single transaction:
   - Inserts into `processed_orders` (with `ON CONFLICT DO NOTHING` as a safety net)
   - Marks the event as `completed`
   - Records the attempt in `attempt_history`

4. **Failure**: On failure, the event goes back to `pending` with `next_retry_at` set using exponential backoff (2^attempt seconds). After `max_attempts`, it's marked `failed`.

5. **Crash recovery**: If a worker dies mid-processing, its lock expires after `LEASE_TIMEOUT_SECONDS` (default 30s). Another worker's next poll will reclaim it via the `locked_at < NOW() - lease_timeout` condition.

### Why PostgreSQL-backed workers (no Redis)

- **Fewer moving parts**: One database for state, locking, and queuing. No Redis to configure, monitor, or lose data from.
- **Transactional guarantees**: The claim, process, and record steps can share a transaction boundary. With Redis, you'd need distributed coordination.
- **`FOR UPDATE SKIP LOCKED`**: PostgreSQL natively supports exactly the locking semantics we need. This is the same pattern used by production job queues like `graphile-worker` and `pgboss`.
- **Trade-off**: Polling adds latency (up to `POLL_INTERVAL_MS`, default 1s) vs. Redis pub/sub push. Acceptable for this use case.

## Correctness Guarantees

### Duplicate protection
- **Ingestion level**: `UNIQUE(event_id)` on `webhook_events` + `ON CONFLICT DO NOTHING` means concurrent identical POSTs are safe.
- **Processing level**: `UNIQUE(event_id)` on `processed_orders` + `ON CONFLICT DO NOTHING` means even if two workers somehow both reach the insert (shouldn't happen due to `FOR UPDATE SKIP LOCKED`, but defense in depth), only one row is created.
- **Claim level**: `FOR UPDATE SKIP LOCKED` prevents two workers from claiming the same event simultaneously.

### Retry behavior
- Exponential backoff: 2s, 4s, 8s, 16s, 32s (for default 5 max attempts).
- `next_retry_at` is set in the future, so the event won't be picked up until the backoff expires.
- After `max_attempts`, the event is marked `failed` and won't be retried unless manually triggered.

### Crash recovery
- Each claim sets `locked_at = NOW()`. If the worker dies, `locked_at` becomes stale.
- The claim query includes `status = 'processing' AND locked_at < NOW() - lease_timeout`, so another worker will reclaim it.
- The reclaiming worker increments `attempt_count`, so the attempt history is accurate.
- `processed_orders` UNIQUE constraint prevents a duplicate row if the original worker somehow completed before dying.

## Known Limitations

1. **A worker that stops renewing its lease may be reclaimed while processing.** Active workers renew `locked_at` periodically; a crashed or unresponsive worker is still recovered after `LEASE_TIMEOUT_SECONDS`.

2. **Polling latency**: Workers poll every `POLL_INTERVAL_MS` (default 1s). Events aren't processed instantly — there's up to 1s delay. For lower latency, you could use PostgreSQL `LISTEN/NOTIFY` to wake workers immediately.

3. **No dead letter queue**: Failed events stay in the `webhook_events` table. In production, you'd want to move permanently failed events to a separate table or external system for investigation.

4. **Single-database bottleneck**: All workers share one PostgreSQL instance. Under very high load (thousands of events/second), the database becomes the bottleneck. At that scale, you'd want Redis or a dedicated message broker.

5. **No graceful shutdown during processing**: If a worker receives SIGTERM while processing a slow event, it exits immediately. The event will be recovered after lease timeout, but ideally the worker would finish the current event before shutting down.

## Hardest Bug

**The concurrent duplicate problem**: During initial testing, I found that when sending the same `eventId` simultaneously (e.g., 10 concurrent POSTs), occasionally two workers would both claim and process the event, resulting in two rows in `processed_orders`.

**How I found it**: The burst test (500 events) with some duplicates mixed in showed the count mismatch.

**Root cause**: The initial implementation used separate queries for "check if already processed" and "insert processed_order". Between the check and the insert, another worker could complete the same event.

**Fix**: Two changes:
1. Made the `processed_orders.event_id` column `UNIQUE` with `ON CONFLICT DO NOTHING` — this is the hard guarantee.
2. The claim query uses `FOR UPDATE SKIP LOCKED` — this is the primary prevention mechanism, ensuring only one worker gets each event.

The UNIQUE constraint is defense-in-depth. The `FOR UPDATE SKIP LOCKED` should prevent the race entirely, but the constraint catches any edge case (like crash recovery reclaim while the original worker is still running).

## What I'd Do Next

1. **LISTEN/NOTIFY for immediate wake**: Replace polling with PostgreSQL notifications. Workers would `LISTEN` on a channel, and the API would `NOTIFY` after inserting an event. Falls back to polling if the notification is missed.

2. **Graceful shutdown**: Trap SIGTERM in workers, finish the current event, then exit. This reduces unnecessary retries during deployments.

3. **Metrics and alerting**: Expose Prometheus metrics (events processed/s, failure rate, queue depth, processing latency). Alert on growing queue depth or high failure rates.

4. **Batch claiming**: Instead of claiming one event at a time, claim a batch (e.g., 10) to reduce database round-trips under high load.

## Tests

Run integration tests (requires running PostgreSQL):

```bash
docker compose up db -d
cd backend
npm install
npm test
```

Tests cover:
- **Duplicate protection under concurrency**: 10 concurrent inserts of the same event → exactly 1 row
- **FOR UPDATE SKIP LOCKED**: Two concurrent claims → only one succeeds
- **Crash recovery**: Stale lock reclaim after timeout
- **Retry behavior**: Backoff timing and permanent failure marking

## Demo Scenarios

```bash
bash scripts/demo.sh
```

Or run individual scenarios:

```bash
# 1. Duplicate event
for i in 1 2 3 4 5; do
  curl -X POST http://localhost:3001/webhooks \
    -H "Content-Type: application/json" \
    -d '{"eventId":"evt_dup","type":"order.created","data":{"orderId":"ORD-1"}}' &
done

# 2. Temporary failure (fails 2x, then succeeds)
curl -X POST http://localhost:3001/webhooks \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt_temp","type":"order.created","data":{"orderId":"ORD-2","simulate":"fail_then_succeed:2"}}'

# 3. Permanent failure
curl -X POST http://localhost:3001/webhooks \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt_perm","type":"order.created","data":{"orderId":"ORD-3","simulate":"always_fail"}}'

# 4. Parallel slow events
for i in 1 2 3 4; do
  curl -X POST http://localhost:3001/webhooks \
    -H "Content-Type: application/json" \
    -d "{\"eventId\":\"evt_slow_$i\",\"type\":\"order.created\",\"data\":{\"orderId\":\"ORD-SLOW-$i\",\"simulate\":\"slow:5\"}}" &
done

# 5. Worker crash
curl -X POST http://localhost:3001/webhooks \
  -H "Content-Type: application/json" \
  -d '{"eventId":"evt_crash","type":"order.created","data":{"orderId":"ORD-CRASH","simulate":"slow:20"}}'
# Then: docker compose kill worker1
# Wait 30s, check: curl http://localhost:3001/api/events/evt_crash

# 6. Burst (500 events)
for i in $(seq 1 500); do
  curl -s -X POST http://localhost:3001/webhooks \
    -H "Content-Type: application/json" \
    -d "{\"eventId\":\"evt_burst_$i\",\"type\":\"order.created\",\"data\":{\"orderId\":\"ORD-B-$i\"}}" &
  [ $((i % 50)) -eq 0 ] && wait
done
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `LEASE_TIMEOUT_SECONDS` | 30 | Seconds before a processing event is considered stuck |
| `POLL_INTERVAL_MS` | 1000 | Worker polling interval in milliseconds |
| `MAX_ATTEMPTS` | 5 | Default max retry attempts per event |
| `WORKER_ID` | auto-generated | Unique identifier for each worker |
