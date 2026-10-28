import { route, getSql, json, isAdmin, gatewayConfig, syncOpenOrders } from '../../lib/store.js';

/**
 * POST /api/admin/sync — refreshes orders that can still change from the gateway. Called every
 * minute by `npm run observer:tunnel` on the merchant's PC (a safety net for lost webhooks that does
 * not depend on the hosting plan's cron limits). Admin token required.
 */
export default route('POST', async request => {
  if (!isAdmin(request)) return json(401, { error: 'Unauthorized' });
  const sql = getSql();
  const link = await gatewayConfig(sql);
  if (!link.ready) return json(200, { checked: 0, linked: false, reason: link.reason });
  const checked = await syncOpenOrders(sql, link.cfg, { limit: 25, budgetMs: 20000 });
  return json(200, { checked, linked: true });
});
