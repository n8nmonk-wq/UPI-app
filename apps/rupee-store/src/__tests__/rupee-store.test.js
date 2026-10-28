import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { OrderStore } from '../orders.js';
import { OrderStatus, nextStatus } from '../status.js';
import { deriveOrderStatus, verifyWebhookSignature } from '../gateway.js';
import { RupeeStoreServer } from '../server.js';

const SECRET = 'whsec_test_secret';

function sign(body, ts = Date.now(), secret = SECRET) {
  return {
    'x-gateway-timestamp': String(ts),
    'x-gateway-signature-v2': `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`
  };
}

function order(overrides = {}) {
  return { id: 'R1-aaaaaaaaaaaaaaaaaaaaaa', paymentId: 'pay-1', amountPaise: 100n, currency: 'INR', status: 'PENDING', ...overrides };
}

function gw(overrides = {}) {
  return { paymentId: 'pay-1', orderId: 'R1-aaaaaaaaaaaaaaaaaaaaaa', amountPaise: '100', currency: 'INR', status: 'OBSERVED_SUCCESS', settlementState: 'NOT_RECONCILED', method: 'UPI', ...overrides };
}

test('webhook signature: valid V2 signature passes', () => {
  const body = '{"event":"OBSERVED_SUCCESS"}';
  assert.equal(verifyWebhookSignature(Buffer.from(body), sign(body), SECRET).ok, true);
});

test('webhook signature: wrong secret, tampered body and stale timestamp are rejected', () => {
  const body = '{"event":"OBSERVED_SUCCESS"}';
  assert.equal(verifyWebhookSignature(Buffer.from(body), sign(body, Date.now(), 'other'), SECRET).ok, false);
  assert.equal(verifyWebhookSignature(Buffer.from(body + ' '), sign(body), SECRET).ok, false);
  const old = Date.now() - 3 * 60 * 60 * 1000;
  assert.equal(verifyWebhookSignature(Buffer.from(body), sign(body, old), SECRET).ok, false);
  assert.equal(verifyWebhookSignature(Buffer.from(body), {}, SECRET).ok, false);
});

test('gateway status: UPI observed success marks the order paid', () => {
  assert.deepEqual(deriveOrderStatus(order(), gw()), { gatewayStatus: 'OBSERVED_SUCCESS', status: OrderStatus.PAID, settlementState: 'NOT_RECONCILED' });
  assert.equal(deriveOrderStatus(order(), gw({ status: 'RECONCILED', settlementState: 'RECONCILED' })).status, OrderStatus.PAID);
});

test('gateway status: mismatched amount, order, payment, currency or method never marks paid', () => {
  assert.equal(deriveOrderStatus(order(), gw({ amountPaise: '1' })), null);
  assert.equal(deriveOrderStatus(order(), gw({ orderId: 'R1-other' })), null);
  assert.equal(deriveOrderStatus(order(), gw({ paymentId: 'pay-2' })), null);
  assert.equal(deriveOrderStatus(order(), gw({ currency: 'USD' })), null);
  assert.equal(deriveOrderStatus(order(), gw({ status: 'SUCCESS', method: 'COD' })), null);
  assert.equal(deriveOrderStatus(order(), gw({ method: 'CASH_COUNTER' })), null);
  assert.equal(deriveOrderStatus(order(), gw({ status: 'MANUAL_REVIEW' })).status, OrderStatus.REVIEW);
});

test('orders: a paid order is never downgraded by a later failure event', () => {
  const store = new OrderStore(':memory:');
  store.create({ id: 'R1-x', sku: 'RUPEE-1', amountPaise: 100n, currency: 'INR' });
  store.attachPayment('R1-x', 'pay-x');
  store.transition('R1-x', OrderStatus.PAID, { settlementState: 'NOT_RECONCILED' });
  store.transition('R1-x', OrderStatus.FAILED);
  store.transition('R1-x', OrderStatus.PAID, { utr: '123456789012' });
  const o = store.get('R1-x');
  assert.equal(o.status, OrderStatus.PAID);
  assert.equal(o.utr, '123456789012');
  assert.equal(store.recordDelivery('d1', 'R1-x', 'OBSERVED_SUCCESS'), true);
  assert.equal(store.recordDelivery('d1', 'R1-x', 'OBSERVED_SUCCESS'), false);
  store.close();
});

async function withStore(gatewayHandler, fn) {
  const gateway = http.createServer(gatewayHandler);
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
  const store = new RupeeStoreServer({
    port: 1, dbPath: ':memory:', gatewayApiUrl: gatewayUrl,
    merchantId: 'm-1', merchantKey: 'mk_live_test', webhookSecret: SECRET
  });
  const server = store.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, store);
  } finally {
    server.close();
    gateway.close();
    store.orders.close();
  }
}

test('store: order price comes from the server and the merchant key is sent to the gateway', async () => {
  let seen;
  await withStore((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen = { headers: req.headers, body: JSON.parse(body) };
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paymentId: 'pay-9', checkoutUrl: 'http://localhost:7000/checkout/pay-9' }));
    });
  }, async base => {
    const res = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 0.01, price: 0.01 })
    });
    assert.equal(res.status, 201);
    assert.equal(seen.body.amount, '1.00');
    assert.equal(seen.headers['x-merchant-key'], 'mk_live_test');
    assert.match(seen.body.orderId, /^R1-[A-Za-z0-9_-]{22}$/);

    const cross = await fetch(`${base}/api/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}'
    });
    assert.equal(cross.status, 403);
  });
});

test('store: forged webhook is rejected and a genuine one is re-verified against the gateway', async () => {
  let gatewayStatus = 'ACTIVE';
  let orderId;
  await withStore((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        orderId = JSON.parse(body).orderId;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ paymentId: 'pay-7', checkoutUrl: 'http://localhost:7000/checkout/pay-7' }));
      });
      return;
    }
    assert.equal(req.headers['x-merchant-key'], 'mk_live_test');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ paymentId: 'pay-7', orderId, amountPaise: '100', currency: 'INR', status: gatewayStatus, method: 'UPI', settlementState: 'NOT_RECONCILED' }));
  }, async base => {
    await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const payload = JSON.stringify({ event: 'OBSERVED_SUCCESS', orderId, paymentId: 'pay-7', utr: '123456789012' });

    const forged = await fetch(`${base}/api/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...sign(payload, Date.now(), 'attacker') }, body: payload
    });
    assert.equal(forged.status, 401);

    // Correctly signed, but the gateway itself does not (yet) report the payment: stays pending.
    const early = await fetch(`${base}/api/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-gateway-delivery-id': 'd-1', ...sign(payload) }, body: payload
    });
    assert.equal((await early.json()).status, 'PENDING');

    gatewayStatus = 'OBSERVED_SUCCESS';
    const real = await fetch(`${base}/api/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-gateway-delivery-id': 'd-2', ...sign(payload) }, body: payload
    });
    assert.equal((await real.json()).status, 'PAID');

    const view = await (await fetch(`${base}/api/orders/${orderId}`)).json();
    assert.equal(view.status, 'PAID');
    assert.equal(view.utr, '123456789012');
  });
});

test('status rules: PAID is final, nothing returns to PENDING, late credits can still resolve', () => {
  assert.equal(nextStatus('PENDING', 'PAID'), 'PAID');
  assert.equal(nextStatus('PAID', 'FAILED'), null);
  assert.equal(nextStatus('PAID', 'REVIEW'), null);
  assert.equal(nextStatus('FAILED', 'PENDING'), null);
  assert.equal(nextStatus('EXPIRED', 'REVIEW'), 'REVIEW');
  assert.equal(nextStatus('FAILED', 'PAID'), 'PAID');
  assert.equal(nextStatus('PENDING', 'BOGUS'), null);
});

test('orders: one UTR can never pay two orders', () => {
  const store = new OrderStore(':memory:');
  for (const id of ['R1-a', 'R1-b']) {
    store.create({ id, sku: 'RUPEE-1', amountPaise: 100n, currency: 'INR' });
    store.attachPayment(id, `pay-${id}`);
  }
  store.transition('R1-a', OrderStatus.PAID, { utr: '111122223333' });
  store.transition('R1-b', OrderStatus.PAID, { utr: '111122223333' });
  assert.equal(store.get('R1-a').utr, '111122223333');
  assert.equal(store.get('R1-b').utr, null);
  store.close();
});

test('store: webhook answers 503 (so the gateway retries) when the read-back fails', async () => {
  let orderId;
  let failRead = true;
  await withStore((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        orderId = JSON.parse(body).orderId;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ paymentId: 'pay-5', checkoutUrl: 'http://localhost:7000/checkout/pay-5' }));
      });
      return;
    }
    if (failRead) { res.writeHead(502); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ paymentId: 'pay-5', orderId, amountPaise: '100', currency: 'INR', status: 'OBSERVED_SUCCESS', method: 'UPI' }));
  }, async (base, store) => {
    await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const payload = JSON.stringify({ event: 'OBSERVED_SUCCESS', orderId, paymentId: 'pay-5', utr: '999988887777' });
    const headers = { 'Content-Type': 'application/json', 'x-gateway-delivery-id': 'd-9' };
    const first = await fetch(`${base}/api/webhook`, { method: 'POST', headers: { ...headers, ...sign(payload) }, body: payload });
    assert.equal(first.status, 503);
    failRead = false;
    store.lastSync.clear();
    const retry = await fetch(`${base}/api/webhook`, { method: 'POST', headers: { ...headers, ...sign(payload) }, body: payload });
    assert.equal((await retry.json()).status, 'PAID');
  });
});
