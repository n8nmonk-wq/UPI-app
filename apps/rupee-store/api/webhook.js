import { verifyWebhookSignature } from '../src/gateway.js';
import { route, getSql, gatewayConfig, json, getOrder, syncOrder, recordUtr, addEvent, q } from '../lib/store.js';

/**
 * POST /api/webhook — gateway webhook. The signature proves the message came from our gateway;
 * the order is then updated only from an authenticated read-back, never from the webhook body.
 */
export default route('POST', async request => {
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > 64 * 1024) return json(413, { error: 'Payload too large' });

  const sql = getSql();
  const { cfg } = await gatewayConfig(sql);
  const check = verifyWebhookSignature(raw, request.headers, cfg.webhookSecret);
  if (!check.ok) {
    console.warn(`[webhook] rejected: ${check.reason}`);
    return json(401, { error: 'Invalid webhook signature' });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  let order = typeof payload.orderId === 'string' ? await getOrder(sql, payload.orderId) : null;
  if (!order || !order.paymentId || order.paymentId !== payload.paymentId) {
    // Not one of ours (another integration on the same merchant). Acknowledge so it is not retried.
    return json(200, { received: true, ignored: true });
  }

  const deliveryId = String(request.headers.get('x-gateway-delivery-id') || payload.deliveryId || '').slice(0, 100);
  if (deliveryId) {
    const seen = await q(sql, 'SELECT 1 FROM webhook_deliveries WHERE delivery_id = $1', [deliveryId]);
    if (seen.length) return json(200, { received: true, duplicate: true });
  }

  const event = String(payload.event || '').slice(0, 40);
  try {
    order = await syncOrder(sql, cfg, order, { force: true, throwOnError: true, source: `webhook ${event}` });
  } catch (err) {
    console.warn(`[webhook] read-back failed for ${order.id}: ${err.message}`);
    // Not recorded as processed: the gateway retries and we get another chance.
    return json(503, { error: 'Gateway read-back failed; retry later' });
  }
  order = await recordUtr(sql, order, payload.utr);

  if (deliveryId) {
    await q(sql, 'INSERT INTO webhook_deliveries (delivery_id, order_id, event) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [deliveryId, order.id, event]);
  }
  await addEvent(sql, order.id, 'WEBHOOK', { detail: `${event} (now ${order.status})` });
  return json(200, { received: true, status: order.status });
});
