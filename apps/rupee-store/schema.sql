-- Neon (Postgres) schema for the Netlify-hosted Rupee Store. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY CHECK (id ~ '^R1-[A-Za-z0-9_-]{22}$'),
  payment_id text UNIQUE,
  sku text NOT NULL,
  amount_paise bigint NOT NULL CHECK (amount_paise > 0),
  currency text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','PAID','REVIEW','FAILED','EXPIRED','CANCELLED')),
  gateway_status text,
  settlement_state text,
  utr text CHECK (utr IS NULL OR utr ~ '^[0-9]{12}$'),
  client_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  last_synced_at timestamptz
);
-- One bank credit (UTR) can only ever pay one order.
CREATE UNIQUE INDEX IF NOT EXISTS orders_utr_unique ON orders (utr) WHERE utr IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_updated_at_idx ON orders (updated_at DESC);
CREATE INDEX IF NOT EXISTS orders_open_idx ON orders (created_at) WHERE status IN ('PENDING','REVIEW');
CREATE INDEX IF NOT EXISTS orders_client_created_idx ON orders (client_key, created_at);

-- Every change to an order, for the live activity feed and for audits.
CREATE TABLE IF NOT EXISTS order_events (
  id bigserial PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind text NOT NULL,
  from_status text,
  to_status text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id text PRIMARY KEY,
  order_id text,
  event text,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Gateway link (merchant id/key, webhook secret, public gateway URL). Secrets are AES-256-GCM encrypted.
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
