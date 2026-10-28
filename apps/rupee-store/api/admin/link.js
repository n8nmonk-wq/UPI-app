import { route, getSql, json, isAdmin, saveSetting, gatewayConfig } from '../../lib/store.js';

const MERCHANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MERCHANT_KEY_RE = /^mk_live_[0-9a-f]{48}$/;
const WEBHOOK_SECRET_RE = /^(whsec_[0-9a-f]{48}|[0-9a-f]{64})$/;

function normaliseGatewayUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.origin;
}

/**
 * Proves the address really is our gateway and that it accepts the merchant key, without creating
 * a payment: an empty create request is checked for the key first (401 if wrong) and only then
 * rejected for missing fields (400).
 */
async function probeGateway(gatewayUrl, merchantId, merchantKey) {
  try {
    const res = await fetch(`${gatewayUrl}/api/v1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Merchant-Id': merchantId, 'X-Merchant-Key': merchantKey },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(8000)
    });
    const body = await res.json().catch(() => null);
    if (res.status === 400 && String(body?.error || '').startsWith('Missing required fields')) return { ok: true };
    if (res.status === 401) return { ok: false, reason: 'the gateway rejected the merchant key' };
    return { ok: false, reason: `unexpected answer (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * POST /api/admin/link — called from the merchant's PC (npm run store:configure / observer:tunnel)
 * with the admin token: stores the merchant credentials (encrypted) and the gateway's public address.
 */
export default route('POST', async request => {
  if (!isAdmin(request)) return json(401, { error: 'Unauthorized' });
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const sql = getSql();
  const updates = {};
  if (body.merchantId !== undefined || body.merchantKey !== undefined || body.webhookSecret !== undefined) {
    if (!MERCHANT_ID_RE.test(String(body.merchantId))) return json(400, { error: 'merchantId must be a UUID' });
    if (!MERCHANT_KEY_RE.test(String(body.merchantKey))) return json(400, { error: 'merchantKey has an unexpected format' });
    if (!WEBHOOK_SECRET_RE.test(String(body.webhookSecret))) return json(400, { error: 'webhookSecret has an unexpected format' });
    updates.merchant_id = body.merchantId;
    updates.merchant_key = body.merchantKey;
    updates.webhook_secret = body.webhookSecret;
  }
  if (body.gatewayUrl !== undefined) {
    const gatewayUrl = normaliseGatewayUrl(body.gatewayUrl);
    if (!gatewayUrl) return json(400, { error: 'gatewayUrl must be an https:// address' });
    updates.gateway_url = gatewayUrl;
  }
  if (!Object.keys(updates).length) return json(400, { error: 'Nothing to update' });

  const { cfg } = await gatewayConfig(sql);
  const merchantId = updates.merchant_id || cfg.merchantId;
  const merchantKey = updates.merchant_key || cfg.merchantKey;
  const gatewayUrl = updates.gateway_url || cfg.gatewayApiUrl;
  if (gatewayUrl && merchantId && merchantKey) {
    const probe = await probeGateway(gatewayUrl, merchantId, merchantKey);
    if (!probe.ok) {
      return json(502, { error: `The store could not reach the gateway at ${gatewayUrl}: ${probe.reason}` });
    }
  }

  for (const [key, value] of Object.entries(updates)) await saveSetting(sql, key, value);
  const after = await gatewayConfig(sql);
  return json(200, { linked: after.ready, gatewayUrl: after.cfg.gatewayApiUrl || null, reason: after.reason });
});
