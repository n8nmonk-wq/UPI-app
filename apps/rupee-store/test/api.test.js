/**
 * Integration tests for the Vercel functions in api/ against a real Postgres (use a Neon test branch).
 * Skipped unless TEST_DATABASE_URL is set. The tables in that database are emptied first, so
 * never point it at production.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = !TEST_DB && 'TEST_DATABASE_URL not set';

const ADMIN = crypto.randomBytes(32).toString('hex');
const MERCHANT_ID = '00000000-0000-0000-0000-000000000001';
const MERCHANT_KEY = `mk_live_${crypto.randomBytes(24).toString('hex')}`;
const WEBHOOK_SECRET = `whsec_${crypto.randomBytes(24).toString('hex')}`;

let fns;
let lib;
let sql;
let gateway;
const gw = { payments: new Map(), failReads: false, refuseCreate: null };

async function call(fn, path, { method = 'GET', headers = {}, body, ip = '203.0.113.7' } = {}) {
  const request = new Request(`https://store.example${path}`, { method, headers: { 'x-real-ip': ip, ...headers }, body });
  const res = await fn.fetch(request);
  return { status: res.status, body: await res.json() };
}

function signed(payload, secret = WEBHOOK_SECRET, ts = Date.now()) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return {
    method: 'POST',
    body: raw,
    headers: { 'content-type': 'application/json', 'x-gateway-timestamp': String(ts), 'x-gateway-signature-v2': `sha256=${sig}`, 'x-gateway-delivery-id': crypto.randomUUID() }
  };
}

async function newOrder(ip) {
  const res = await call(fns.create, '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"amount":"0.01"}', ip: ip || `198.51.100.${Math.floor(Math.random() * 250)}` });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const order = await lib.getOrder(sql, res.body.orderId);
  return { ...res.body, paymentId: order.paymentId };
}

before(async () => {
  if (skip) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.STORE_ADMIN_TOKEN = ADMIN;
  process.env.STORE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  process.env.STORE_PUBLIC_URL = 'https://store.example';

  // A stand-in for the YOUPI payment API (create + authenticated read-back).
  gateway = http.createServer((r, s) => {
    let body = '';
    r.on('data', c => { body += c; });
    r.on('end', () => {
      if (r.headers['x-merchant-key'] !== MERCHANT_KEY) { s.writeHead(401); s.end('{}'); return; }
      if (r.method === 'POST') {
        if (gw.refuseCreate) { s.writeHead(503, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(gw.refuseCreate)); return; }
        const b = JSON.parse(body);
        const paymentId = crypto.randomUUID();
        gw.payments.set(paymentId, { paymentId, orderId: b.orderId, amountPaise: String(Math.round(Number(b.amount) * 100)), currency: b.currency, status: 'ACTIVE', method: 'UPI', settlementState: 'NOT_APPLICABLE' });
        s.writeHead(201, { 'Content-Type': 'application/json' });
        s.end(JSON.stringify({ paymentId, checkoutUrl: `http://localhost:7000/checkout/${paymentId}` }));
        return;
      }
      if (gw.failReads) { s.writeHead(502); s.end(); return; }
      const p = gw.payments.get(decodeURIComponent(r.url.split('/').pop()));
      s.writeHead(p ? 200 : 404, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify(p || { error: 'Payment session not found' }));
    });
  });
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));

  lib = await import('../lib/store.js');
  fns = {
    create: (await import('../api/orders/index.js')).default,
    get: (await import('../api/orders/[id].js')).default,
    webhook: (await import('../api/webhook.js')).default,
    adminOrders: (await import('../api/admin/orders.js')).default,
    adminLink: (await import('../api/admin/link.js')).default,
    adminSync: (await import('../api/admin/sync.js')).default,
    product: (await import('../api/product.js')).default
  };
  sql = lib.getSql();
  for (const t of ['order_events', 'webhook_deliveries', 'orders', 'settings']) await lib.q(sql, `DELETE FROM ${t}`);
  await lib.saveSetting(sql, 'merchant_id', MERCHANT_ID);
  await lib.saveSetting(sql, 'merchant_key', MERCHANT_KEY);
  await lib.saveSetting(sql, 'webhook_secret', WEBHOOK_SECRET);
  await lib.saveSetting(sql, 'gateway_url', `http://127.0.0.1:${gateway.address().port}`);
});

after(() => gateway?.close());

test('secrets are stored encrypted, never in plain text', { skip }, async () => {
  const rows = await lib.q(sql, "SELECT key, value FROM settings WHERE key IN ('merchant_key', 'webhook_secret')");
  for (const r of rows) {
    assert.match(r.value, /^v1:/);
    assert.ok(!r.value.includes(MERCHANT_KEY) && !r.value.includes(WEBHOOK_SECRET));
  }
});

test('order price comes from the server, not the request', { skip }, async () => {
  const o = await newOrder();
  assert.equal(gw.payments.get(o.paymentId).amountPaise, '100');
  assert.match(o.checkoutUrl, /^http:\/\/127\.0\.0\.1:\d+\/checkout\//);
});

test('a forged webhook is rejected and changes nothing', { skip }, async () => {
  const o = await newOrder();
  gw.payments.get(o.paymentId).status = 'OBSERVED_SUCCESS';
  const res = await call(fns.webhook, '/api/webhook', signed({ event: 'OBSERVED_SUCCESS', orderId: o.orderId, paymentId: o.paymentId, utr: '123412341234' }, 'whsec_attacker'));
  assert.equal(res.status, 401);
  assert.equal((await lib.getOrder(sql, o.orderId)).status, 'PENDING');
});

test('a signed webhook only marks paid what the gateway itself reports as paid', { skip }, async () => {
  const o = await newOrder();
  // Signed, but the gateway still says ACTIVE: stays pending.
  let res = await call(fns.webhook, '/api/webhook', signed({ event: 'OBSERVED_SUCCESS', orderId: o.orderId, paymentId: o.paymentId, utr: '555566667777' }));
  assert.equal(res.body.status, 'PENDING');
  gw.payments.get(o.paymentId).status = 'OBSERVED_SUCCESS';
  gw.payments.get(o.paymentId).settlementState = 'NOT_RECONCILED';
  res = await call(fns.webhook, '/api/webhook', signed({ event: 'OBSERVED_SUCCESS', orderId: o.orderId, paymentId: o.paymentId, utr: '555566667777' }));
  assert.equal(res.body.status, 'PAID');
  const view = await call(fns.get, `/api/orders/${o.orderId}`);
  assert.equal(view.body.status, 'PAID');
  assert.equal(view.body.utr, '555566667777');
});

test('wrong amount at the gateway never marks the order paid', { skip }, async () => {
  const o = await newOrder();
  Object.assign(gw.payments.get(o.paymentId), { status: 'OBSERVED_SUCCESS', amountPaise: '1' });
  const res = await call(fns.webhook, '/api/webhook', signed({ event: 'OBSERVED_SUCCESS', orderId: o.orderId, paymentId: o.paymentId }));
  assert.equal(res.body.status, 'PENDING');
});

test('webhook with a payment id that does not belong to the order is ignored', { skip }, async () => {
  const o = await newOrder();
  const res = await call(fns.webhook, '/api/webhook', signed({ event: 'OBSERVED_SUCCESS', orderId: o.orderId, paymentId: crypto.randomUUID() }));
  assert.equal(res.body.ignored, true);
});

test('webhook answers 503 when the gateway read-back fails, and the retry succeeds', { skip }, async () => {
  const o = await newOrder();
  gw.payments.get(o.paymentId).status = 'OBSERVED_SUCCESS';
  const message = signed({ event: 'OBSERVED_SUCCESS', orderId: o.orderId, paymentId: o.paymentId, utr: '888877776666' });
  gw.failReads = true;
  let res = await call(fns.webhook, '/api/webhook', message);
  assert.equal(res.status, 503);
  gw.failReads = false;
  res = await call(fns.webhook, '/api/webhook', message); // same delivery id, retried
  assert.equal(res.body.status, 'PAID');
});

test('a paid order is never downgraded by a later failure', { skip }, async () => {
  const o = await newOrder();
  gw.payments.get(o.paymentId).status = 'OBSERVED_SUCCESS';
  await call(fns.webhook, '/api/webhook', signed({ event: 'OBSERVED_SUCCESS', orderId: o.orderId, paymentId: o.paymentId }));
  gw.payments.get(o.paymentId).status = 'FAILED';
  await call(fns.webhook, '/api/webhook', signed({ event: 'FAILED', orderId: o.orderId, paymentId: o.paymentId }));
  assert.equal((await lib.getOrder(sql, o.orderId)).status, 'PAID');
});

test('one UTR can never be attached to two orders', { skip }, async () => {
  const a = await newOrder();
  const b = await newOrder();
  for (const o of [a, b]) {
    gw.payments.get(o.paymentId).status = 'OBSERVED_SUCCESS';
    await call(fns.webhook, '/api/webhook', signed({ event: 'OBSERVED_SUCCESS', orderId: o.orderId, paymentId: o.paymentId, utr: '424242424242' }));
  }
  assert.equal((await lib.getOrder(sql, a.orderId)).utr, '424242424242');
  assert.equal((await lib.getOrder(sql, b.orderId)).utr, null);
  const flagged = await lib.q(sql, "SELECT 1 FROM order_events WHERE order_id = $1 AND kind = 'DUPLICATE_UTR'", [b.orderId]);
  assert.equal(flagged.length, 1);
});

test('checkout creation is rate limited per client', { skip }, async () => {
  const ip = '192.0.2.99';
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const r = await call(fns.create, '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ip });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [201, 201, 201, 429]);
});

test('cross-origin and non-JSON order requests are refused', { skip }, async () => {
  let r = await call(fns.create, '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r.status, 403);
  r = await call(fns.create, '/api/orders', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
});

test('a gateway refusal is recorded as a failed order with the reason', { skip }, async () => {
  gw.refuseCreate = { error: 'observers offline', code: 'OBSERVERS_UNHEALTHY' };
  try {
    const r = await call(fns.create, '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', ip: '192.0.2.50' });
    assert.equal(r.status, 503);
    const rows = await lib.q(sql, "SELECT o.status, e.detail FROM orders o JOIN order_events e ON e.order_id = o.id AND e.kind = 'CREATE_FAILED' ORDER BY o.created_at DESC LIMIT 1");
    assert.equal(rows[0].status, 'FAILED');
    assert.match(rows[0].detail, /OBSERVERS_UNHEALTHY/);
  } finally {
    gw.refuseCreate = null;
  }
});

test('admin endpoints require the admin token', { skip }, async () => {
  assert.equal((await call(fns.adminOrders, '/api/admin/orders')).status, 401);
  assert.equal((await call(fns.adminOrders, '/api/admin/orders', { headers: { authorization: 'Bearer nope' } })).status, 401);
  const ok = await call(fns.adminOrders, '/api/admin/orders', { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.orders.length > 0);
  assert.ok(ok.body.stats.PAID.count >= 1);
  assert.ok(!JSON.stringify(ok.body).includes(MERCHANT_KEY));
  const link = await call(fns.adminLink, '/api/admin/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"gatewayUrl":"https://x.example"}' });
  assert.equal(link.status, 401);
});

test('admin link validates input and refuses plain-http gateways', { skip }, async () => {
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` };
  let r = await call(fns.adminLink, '/api/admin/link', { method: 'POST', headers: auth, body: '{"gatewayUrl":"http://insecure.example"}' });
  assert.equal(r.status, 400);
  r = await call(fns.adminLink, '/api/admin/link', { method: 'POST', headers: auth, body: JSON.stringify({ merchantId: MERCHANT_ID, merchantKey: 'nope', webhookSecret: WEBHOOK_SECRET }) });
  assert.equal(r.status, 400);
});

test('unknown or malformed order ids return 404', { skip }, async () => {
  assert.equal((await call(fns.get, `/api/orders/${encodeURIComponent("R1-'; DROP TABLE orders;--")}`)).status, 404);
  assert.equal((await call(fns.get, '/api/orders/R1-AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
});

test('settings encrypted with another key read as "not linked" instead of crashing', { skip }, async () => {
  const saved = process.env.STORE_ENCRYPTION_KEY;
  process.env.STORE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  try {
    const link = await lib.gatewayConfig(sql);
    assert.equal(link.ready, false);
    const product = await call(fns.product, '/api/product');
    assert.equal(product.status, 200);
    assert.equal(product.body.ready, false);
  } finally {
    process.env.STORE_ENCRYPTION_KEY = saved;
  }
});

test('wrong HTTP methods are refused', { skip }, async () => {
  assert.equal((await call(fns.create, '/api/orders')).status, 405);
  assert.equal((await call(fns.webhook, '/api/webhook')).status, 405);
});

test('admin sync refreshes open orders and requires the token', { skip }, async () => {
  assert.equal((await call(fns.adminSync, '/api/admin/sync', { method: 'POST' })).status, 401);
  const o = await newOrder();
  gw.payments.get(o.paymentId).status = 'EXPIRED';
  await lib.q(sql, 'UPDATE orders SET last_synced_at = NULL WHERE id = $1', [o.orderId]);
  const r = await call(fns.adminSync, '/api/admin/sync', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(r.status, 200);
  assert.ok(r.body.checked >= 1);
  assert.equal((await lib.getOrder(sql, o.orderId)).status, 'EXPIRED');
});
