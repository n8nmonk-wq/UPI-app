import { route, getSql, gatewayConfig, json, PRODUCT, formatRupees } from '../lib/store.js';

/** GET /api/product — product info and whether customers can pay right now. */
export default route('GET', async () => {
  let ready = false;
  let notReadyReason = 'The store is temporarily unavailable.';
  try {
    const link = await gatewayConfig(getSql());
    ready = link.ready;
    notReadyReason = link.reason;
  } catch (err) {
    console.error('[product] could not read gateway link:', err.message);
  }
  return json(200, {
    sku: PRODUCT.sku,
    name: PRODUCT.name,
    description: PRODUCT.description,
    amount: formatRupees(PRODUCT.amountPaise),
    currency: PRODUCT.currency,
    ready,
    notReadyReason: ready ? null : notReadyReason
  });
});
