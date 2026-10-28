import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { GatewayClient, deriveOrderStatus, cleanUtr } from '../src/gateway.js';
import { OrderStatus, nextStatus } from '../src/status.js';
import { PRODUCT, formatRupees } from '../src/product.js';

export { PRODUCT, formatRupees, OrderStatus };

const SYNC_THROTTLE_SECONDS = 3;
const ORDERS_PER_CLIENT_PER_MINUTE = 3;
const MAX_OPEN_ORDERS_10_MIN = 20;
const PAYMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function env(name) {
  return (process.env[name] ?? '').trim();
}

let cachedSql = null;
/** Neon HTTP driver: one round-trip per statement, ideal for short-lived functions. */
export function getSql() {
  if (cachedSql) return cachedSql;
  const url = env('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL is not configured');
  cachedSql = neon(url);
  return cachedSql;
}

/** Runs a parameterised statement and returns rows. Accepts the Neon driver or a test double. */
export async function q(sql, text, params = []) {
  return sql.query(text, params);
}

// ---------------------------------------------------------------- responses

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Strict-Transport-Security': 'max-age=31536000'
};

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra }
  });
}

// ---------------------------------------------------------------- secrets

function encryptionKey() {
  const hex = env('STORE_ENCRYPTION_KEY');
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('STORE_ENCRYPTION_KEY must be 64 hex characters');
  return Buffer.from(hex, 'hex');
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

export function decrypt(value) {
  const [v, iv, tag, ct] = String(value).split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

/** Constant-time check of "Authorization: Bearer <STORE_ADMIN_TOKEN>". */
export function isAdmin(req) {
  const expected = env('STORE_ADMIN_TOKEN');
  if (expected.length < 32) return false;
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '');
  if (!match) return false;
  return crypto.timingSafeEqual(sha256(match[1].trim()), sha256(expected));
}

/** Rate-limit key: keyed hash of the client IP, so raw IPs are never stored. */
export function clientKey(ip) {
  return crypto.createHmac('sha256', encryptionKey()).update(`client:${ip || 'unknown'}`).digest('base64url').slice(0, 32);
}

// ---------------------------------------------------------------- settings / gateway link

const SECRET_SETTINGS = new Set(['merchant_key', 'webhook_secret']);

export async function loadSettings(sql) {
  const rows = await q(sql, 'SELECT key, value, updated_at FROM settings');
  const out = {};
  for (const row of rows) {
    if (SECRET_SETTINGS.has(row.key)) {
      try {
        out[row.key] = decrypt(row.value);
      } catch (err) {
        // Stored with a different STORE_ENCRYPTION_KEY: treat as not linked (re-run store:configure).
        console.error(`[rupee-store] cannot decrypt setting ${row.key}: ${err.message}`);
        continue;
      }
    } else {
      out[row.key] = row.value;
    }
    out[`${row.key}_updated_at`] = row.updated_at;
  }
  return out;
}

export async function saveSetting(sql, key, value) {
  const stored = SECRET_SETTINGS.has(key) ? encrypt(value) : String(value);
  await q(sql, `
    INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `, [key, stored]);
}

/** Gateway connection for this request, or null with a reason when the store is not linked yet. */
export async function gatewayConfig(sql) {
  const s = await loadSettings(sql);
  const cfg = {
    merchantId: s.merchant_id || '',
    merchantKey: s.merchant_key || '',
    webhookSecret: s.webhook_secret || '',
    gatewayApiUrl: s.gateway_url || '',
    gatewayUrlUpdatedAt: s.gateway_url_updated_at || null,
    merchantUpdatedAt: s.merchant_key_updated_at || null
  };
  if (!cfg.merchantId || !cfg.merchantKey || !cfg.webhookSecret) {
    return { cfg, ready: false, reason: 'This store is not linked to its payment gateway yet.' };
  }
  if (!cfg.gatewayApiUrl) {
    return { cfg, ready: false, reason: 'The payment gateway is offline right now. Please try again shortly.' };
  }
  return { cfg, ready: true, reason: null };
}

/**
 * Public address of the store, used for the customer's return link after paying. STORE_PUBLIC_URL
 * wins (set it when you use a custom domain); otherwise Vercel's production domain; otherwise the
 * address this request came in on.
 */
export function siteUrl(request) {
  const explicit = env('STORE_PUBLIC_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  const vercelProd = env('VERCEL_PROJECT_PRODUCTION_URL');
  if (vercelProd) return `https://${vercelProd.replace(/\/+$/, '')}`;
  return new URL(request.url).origin;
}

/** Client IP as reported by the platform edge (Vercel sets x-real-ip / x-forwarded-for itself). */
export function clientIp(request) {
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded ? forwarded.split(',')[0].trim() : 'unknown';
}

/**
 * Wraps a handler as a Vercel Function ({ fetch }) that only answers the given method(s) and turns
 * unexpected errors into a JSON 500 without leaking details.
 */
export function route(methods, handler) {
  const allowed = [].concat(methods);
  return {
    async fetch(request) {
      if (!allowed.includes(request.method)) {
        return json(405, { error: 'Method not allowed' }, { Allow: allowed.join(', ') });
      }
      try {
        return await handler(request);
      } catch (err) {
        console.error(`[rupee-store] ${request.method} ${new URL(request.url).pathname} failed:`, err);
        return json(500, { error: 'Internal error' });
      }
    }
  };
}

// ---------------------------------------------------------------- orders

export function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    paymentId: row.payment_id,
    sku: row.sku,
    amountPaise: BigInt(row.amount_paise),
    currency: row.currency,
    status: row.status,
    gatewayStatus: row.gateway_status,
    settlementState: row.settlement_state,
    utr: row.utr,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    paidAt: toIso(row.paid_at)
  };
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** What a customer may see about their own order. */
export function publicOrder(order) {
  return {
    orderId: order.id,
    product: PRODUCT.name,
    amount: formatRupees(order.amountPaise),
    currency: order.currency,
    status: order.status,
    settlementState: order.settlementState,
    utr: order.status === OrderStatus.PAID ? order.utr : null,
    createdAt: order.createdAt,
    paidAt: order.paidAt
  };
}

export async function getOrder(sql, id) {
  const rows = await q(sql, 'SELECT * FROM orders WHERE id = $1', [id]);
  return mapOrder(rows[0]);
}

export async function addEvent(sql, orderId, kind, { from = null, to = null, detail = null } = {}) {
  await q(sql, 'INSERT INTO order_events (order_id, kind, from_status, to_status, detail) VALUES ($1, $2, $3, $4, $5)',
    [orderId, kind, from, to, detail ? String(detail).slice(0, 500) : null]);
}

/**
 * Inserts a new PENDING order unless this client already created too many in the last minute or
 * too many orders are open overall (each one holds a place in the gateway's one-at-a-time queue).
 * Both checks and the insert are a single statement, so concurrent requests cannot slip past.
 */
export async function createOrderRow(sql, { id, key }) {
  const rows = await q(sql, `
    INSERT INTO orders (id, sku, amount_paise, currency, status, client_key)
    SELECT $1, $2, $3, $4, 'PENDING', $5
    WHERE (SELECT count(*) FROM orders WHERE client_key = $5 AND created_at > now() - interval '1 minute') < $6
      AND (SELECT count(*) FROM orders WHERE status = 'PENDING' AND created_at > now() - interval '10 minutes') < $7
    RETURNING *
  `, [id, PRODUCT.sku, PRODUCT.amountPaise.toString(), PRODUCT.currency, key, ORDERS_PER_CLIENT_PER_MINUTE, MAX_OPEN_ORDERS_10_MIN]);
  return mapOrder(rows[0]);
}

export async function attachPayment(sql, orderId, paymentId) {
  if (!PAYMENT_ID_RE.test(String(paymentId))) throw new Error('Gateway returned an invalid payment id');
  await q(sql, 'UPDATE orders SET payment_id = $2, updated_at = now() WHERE id = $1 AND payment_id IS NULL', [orderId, paymentId]);
}

export async function markCreateFailed(sql, orderId, reason) {
  await q(sql, `UPDATE orders SET status = 'FAILED', gateway_status = 'NOT_CREATED', updated_at = now() WHERE id = $1 AND status = 'PENDING'`, [orderId]);
  await addEvent(sql, orderId, 'CREATE_FAILED', { from: 'PENDING', to: 'FAILED', detail: reason });
}

/**
 * Applies a gateway-derived result. The status change is conditional on the status we read, so
 * two concurrent syncs cannot both apply (or apply out of order).
 */
export async function applyGatewayResult(sql, order, next, source) {
  const target = nextStatus(order.status, next.status);
  if (target) {
    const rows = await q(sql, `
      UPDATE orders SET status = $3, gateway_status = $4, settlement_state = COALESCE($5, settlement_state),
        paid_at = CASE WHEN $3 = 'PAID' THEN COALESCE(paid_at, now()) ELSE paid_at END, updated_at = now()
      WHERE id = $1 AND status = $2
      RETURNING *
    `, [order.id, order.status, target, next.gatewayStatus || null, next.settlementState || null]);
    if (rows[0]) {
      await addEvent(sql, order.id, 'STATUS', { from: order.status, to: target, detail: `${source}: gateway ${next.gatewayStatus}` });
      return mapOrder(rows[0]);
    }
    return getOrder(sql, order.id);
  }
  const settlementChanged = next.settlementState && next.settlementState !== order.settlementState && order.status === OrderStatus.PAID;
  if ((next.gatewayStatus && next.gatewayStatus !== order.gatewayStatus) || settlementChanged) {
    const rows = await q(sql, `
      UPDATE orders SET gateway_status = $2,
        settlement_state = CASE WHEN status = 'PAID' THEN COALESCE($3, settlement_state) ELSE settlement_state END,
        updated_at = now()
      WHERE id = $1 RETURNING *
    `, [order.id, next.gatewayStatus || order.gatewayStatus, next.settlementState || null]);
    if (settlementChanged) await addEvent(sql, order.id, 'SETTLEMENT', { detail: `${order.settlementState || '-'} -> ${next.settlementState}` });
    return mapOrder(rows[0]);
  }
  return order;
}

/** Records the bank reference on a paid order. One UTR can never be attached to two orders. */
export async function recordUtr(sql, order, rawUtr) {
  const utr = cleanUtr(rawUtr);
  if (!utr || order.status !== OrderStatus.PAID || order.utr) return order;
  try {
    const rows = await q(sql, `UPDATE orders SET utr = $2, updated_at = now() WHERE id = $1 AND utr IS NULL AND status = 'PAID' RETURNING *`, [order.id, utr]);
    if (rows[0]) {
      await addEvent(sql, order.id, 'UTR', { detail: utr });
      return mapOrder(rows[0]);
    }
  } catch (err) {
    if (err?.code !== '23505') throw err;
    await addEvent(sql, order.id, 'DUPLICATE_UTR', { detail: `UTR ${utr} already belongs to another order` });
  }
  return getOrder(sql, order.id);
}

/**
 * Refreshes an order from an authenticated gateway read. Throttled per order across all function
 * instances by an atomic claim on last_synced_at. With `throwOnError`, a failed read throws so the
 * caller (webhook) can answer non-2xx and get retried.
 */
export async function syncOrder(sql, cfg, order, { force = false, throwOnError = false, source = 'poll' } = {}) {
  if (!order?.paymentId) return order;
  if (order.status === OrderStatus.PAID && order.settlementState === 'RECONCILED') return order;
  const claimed = await q(sql, `
    UPDATE orders SET last_synced_at = now()
    WHERE id = $1 AND ($2 OR last_synced_at IS NULL OR last_synced_at < now() - make_interval(secs => $3))
    RETURNING *
  `, [order.id, force, SYNC_THROTTLE_SECONDS]);
  if (!claimed[0]) return order;
  const current = mapOrder(claimed[0]);
  let gw;
  try {
    gw = await new GatewayClient(cfg).getPayment(current.paymentId);
  } catch (err) {
    if (throwOnError) throw err;
    return current;
  }
  const next = deriveOrderStatus(current, gw);
  if (!next) {
    if (gw?.status !== 'SUCCESS') {
      console.warn(`[rupee-store] gateway record for ${current.id} does not match the order; ignored`);
    }
    return current;
  }
  return applyGatewayResult(sql, current, next, source);
}

/** Orders that may still change: open ones and recent failures a late credit could still resolve. */
export async function syncOpenOrders(sql, cfg, { limit = 10, maxAgeMinutes = 120, budgetMs = 8000 } = {}) {
  const rows = await q(sql, `
    SELECT * FROM orders
    WHERE payment_id IS NOT NULL AND status <> 'PAID' AND created_at > now() - make_interval(mins => $1)
      AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(secs => $2))
    ORDER BY created_at DESC LIMIT $3
  `, [maxAgeMinutes, SYNC_THROTTLE_SECONDS, limit]);
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(resolve, budgetMs); });
  try {
    await Promise.race([
      Promise.allSettled(rows.map(r => syncOrder(sql, cfg, mapOrder(r), { source: 'background' }))),
      deadline
    ]);
  } finally {
    clearTimeout(timer);
  }
  return rows.length;
}
