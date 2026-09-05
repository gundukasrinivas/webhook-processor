-- Webhook events table
CREATE TABLE IF NOT EXISTS webhook_events (
  id            SERIAL PRIMARY KEY,
  event_id      VARCHAR(255) NOT NULL UNIQUE,
  type          VARCHAR(255) NOT NULL,
  data          JSONB NOT NULL DEFAULT '{}',
  status        VARCHAR(50) NOT NULL DEFAULT 'pending',
  -- pending | processing | completed | failed
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  next_retry_at TIMESTAMPTZ,
  locked_by     VARCHAR(255),
  locked_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The business action table — record of real work done
CREATE TABLE IF NOT EXISTS processed_orders (
  id            SERIAL PRIMARY KEY,
  order_id      VARCHAR(255) NOT NULL,
  event_id      VARCHAR(255) NOT NULL UNIQUE,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Attempt history table
CREATE TABLE IF NOT EXISTS attempt_history (
  id            SERIAL PRIMARY KEY,
  event_id      VARCHAR(255) NOT NULL,
  attempt_number INTEGER NOT NULL,
  worker_id     VARCHAR(255) NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  result        VARCHAR(50), -- success | failure
  error         TEXT,
  CONSTRAINT fk_event FOREIGN KEY (event_id) REFERENCES webhook_events(event_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_events_status ON webhook_events(status);
CREATE INDEX IF NOT EXISTS idx_events_next_retry ON webhook_events(next_retry_at);
CREATE INDEX IF NOT EXISTS idx_events_locked_at ON webhook_events(locked_at);
CREATE INDEX IF NOT EXISTS idx_attempts_event_id ON attempt_history(event_id);
CREATE INDEX IF NOT EXISTS idx_processed_orders_event_id ON processed_orders(event_id);
