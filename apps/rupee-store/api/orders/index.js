import crypto from 'node:crypto';
import { GatewayClient } from '../../src/gateway.js';
import {
  route, getSql, gatewayConfig, json, clientKey, clientIp, siteUrl, createOrderRow, attachPayment, markCreateFailed, addEvent
} from '../../lib/store.js';

/** POST /api/orders — starts a checkout for the single ₹1 product. */
export default route('POST', async request => {
  const site = siteUrl(request);
  const origin = request.headers.get('origin');
  if (origin && origin !== site && origin !== new URL(request.url).origin) {
    return json(403, { error: 'Cross-origin request blocked' });
  }
  if (!String(request.headers.get('content-type') || '').startsWith('application/json')) {
    return json(415, { error: 'Content-Type must be application/json' });
  }
  // The body is ignored on purpose: product and price come from the server only.

  const sql = getSql();
  const { cfg, ready, reason } = await gatewayConfig(sql);
  if (!ready) return json(503, { error: reason });

  const orderId = `R1-${crypto.randomBytes(16).toString('base64url')}`;
  const order = await createOrderRow(sql, { id: orderId, key: clientKey(clientIp(request)) });
  if (!order) {
    return json(429, { error: 'Too many checkouts right now. Please wait a minute and try again.' }, { 'Retry-After': '60' });
  }
  await addEvent(sql, orderId, 'CREATED', { to: 'PENDING' });

  let payment;
  try {
    payment = await new GatewayClient(cfg).createPayment({
      orderId,
      amountPaise: order.amountPaise,
      currency: order.currency,
      returnUrl: `${site}/?order=${encodeURIComponent(orderId)}`,
      metadata: { sku: order.sku }
    });
    await attachPayment(sql, orderId, payment.paymentId);
  } catch (err) {
    await markCreateFailed(sql, orderId, `${err.code || 'ERROR'}: ${err.message}`);
    console.warn(`[orders] gateway refused ${orderId}: ${err.code || ''} ${err.message}`);
    if (err.code === 'OBSERVERS_UNHEALTHY') {
      return json(503, { error: "UPI payments are paused: the merchant's payment phone is offline. Please try again shortly." });
    }
    return json(502, { error: 'Could not start the payment. Please try again.' });
  }
  await addEvent(sql, orderId, 'PAYMENT_CREATED', { detail: payment.paymentId });

  // The gateway builds checkout links from its own (local) address; customers need the public one.
  const checkoutUrl = `${cfg.gatewayApiUrl}/checkout/${encodeURIComponent(payment.paymentId)}`;
  return json(201, { orderId, checkoutUrl });
});
