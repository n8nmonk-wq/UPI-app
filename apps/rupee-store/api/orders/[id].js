import { ORDER_ID_RE } from '../../src/product.js';
import { route, getSql, gatewayConfig, json, getOrder, syncOrder, publicOrder } from '../../lib/store.js';

/** GET /api/orders/:id — the customer's order status (refreshed from the gateway, throttled). */
export default route('GET', async request => {
  const orderId = decodeURIComponent(new URL(request.url).pathname.split('/').pop() || '');
  if (!ORDER_ID_RE.test(orderId)) return json(404, { error: 'Order not found' });

  const sql = getSql();
  let order = await getOrder(sql, orderId);
  if (!order) return json(404, { error: 'Order not found' });

  const { cfg, ready } = await gatewayConfig(sql);
  if (ready) order = await syncOrder(sql, cfg, order, { source: 'customer page' });
  return json(200, publicOrder(order));
});
