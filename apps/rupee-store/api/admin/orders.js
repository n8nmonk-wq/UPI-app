import { route, getSql, json, isAdmin, gatewayConfig, syncOpenOrders, mapOrder, formatRupees, q } from '../../lib/store.js';

/**
 * GET /api/admin/orders — live dashboard feed (polled every couple of seconds by /admin.html). Before answering it refreshes
 * a few open orders from the gateway, so the table stays correct even when no customer page is open.
 */
export default route('GET', async request => {
  if (!isAdmin(request)) return json(401, { error: 'Unauthorized' });
  const sql = getSql();
  const link = await gatewayConfig(sql);
  if (link.ready) await syncOpenOrders(sql, link.cfg, { limit: 5, budgetMs: 6000 });

  const [orders, stats, events, paidToday] = await Promise.all([
    q(sql, 'SELECT * FROM orders ORDER BY created_at DESC LIMIT 200'),
    q(sql, `
      SELECT status, count(*)::int AS count, coalesce(sum(amount_paise), 0)::text AS paise,
             count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')::int AS today
      FROM orders GROUP BY status
    `),
    q(sql, 'SELECT id, order_id, kind, from_status, to_status, detail, created_at FROM order_events ORDER BY id DESC LIMIT 40'),
    q(sql, `
      SELECT count(*)::int AS count, coalesce(sum(amount_paise), 0)::text AS paise FROM orders
      WHERE status = 'PAID' AND paid_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
    `)
  ]);

  const byStatus = Object.fromEntries(stats.map(s => [s.status, { count: s.count, today: s.today, amount: formatRupees(s.paise) }]));
  return json(200, {
    serverTime: new Date().toISOString(),
    gateway: {
      linked: link.ready,
      reason: link.reason,
      host: link.cfg.gatewayApiUrl ? new URL(link.cfg.gatewayApiUrl).host : null,
      updatedAt: link.cfg.gatewayUrlUpdatedAt
    },
    stats: byStatus,
    paidToday: { count: paidToday[0].count, amount: formatRupees(paidToday[0].paise) },
    orders: orders.map(r => {
      const o = mapOrder(r);
      return {
        orderId: o.id,
        paymentId: o.paymentId,
        amount: formatRupees(o.amountPaise),
        status: o.status,
        gatewayStatus: o.gatewayStatus,
        settlementState: o.settlementState,
        utr: o.utr,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        paidAt: o.paidAt
      };
    }),
    events: events.map(e => ({
      id: String(e.id),
      orderId: e.order_id,
      kind: e.kind,
      from: e.from_status,
      to: e.to_status,
      detail: e.detail,
      at: new Date(e.created_at).toISOString()
    }))
  });
});
