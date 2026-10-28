import { route, getSql, json, gatewayConfig } from '../lib/store.js';

/** GET /api/health — database reachable and gateway linked (no secrets). */
export default route('GET', async () => {
  try {
    const link = await gatewayConfig(getSql());
    return json(200, { status: 'UP', database: 'ok', gatewayLinked: link.ready });
  } catch (err) {
    console.error('[health]', err.message);
    return json(503, { status: 'DEGRADED', database: 'error' });
  }
});
