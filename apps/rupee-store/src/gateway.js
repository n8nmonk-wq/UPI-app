import crypto from 'node:crypto';
import { OrderStatus } from './status.js';
import { formatRupees } from './product.js';

const GATEWAY_TIMEOUT_MS = 10000;

/**
 * Talks to the YOUPI payment API with the merchant key. `gatewayApiUrl` is either the local API
 * (http://127.0.0.1:6100) or the gateway's public tunnel address, whose checkout portal proxies
 * /api/* to the same API.
 */
export class GatewayClient {
  constructor(config) {
    this.config = config;
  }

  headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      'X-Merchant-Id': this.config.merchantId,
      'X-Merchant-Key': this.config.merchantKey,
      ...extra
    };
  }

  async createPayment({ orderId, amountPaise, currency, returnUrl, metadata }) {
    const res = await fetch(`${this.config.gatewayApiUrl}/api/v1/payments`, {
      method: 'POST',
      headers: this.headers({ 'Idempotency-Key': orderId }),
      body: JSON.stringify({ orderId, amount: formatRupees(amountPaise), currency, returnUrl, metadata }),
      redirect: 'error',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `Gateway returned HTTP ${res.status}`);
      err.status = res.status;
      err.code = body.code;
      throw err;
    }
    return body;
  }

  /** Authoritative read of a payment, authenticated with the merchant key. */
  async getPayment(paymentId) {
    const res = await fetch(`${this.config.gatewayApiUrl}/api/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: this.headers(),
      redirect: 'error',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`Gateway status read failed: HTTP ${res.status}`);
    return res.json();
  }
}

/**
 * Maps a gateway payment record onto a store order status, after checking that the record
 * really belongs to this order (same payment id, order id, amount and currency). Any mismatch
 * returns null and the order is left untouched.
 */
export function deriveOrderStatus(order, gw) {
  if (!gw || !order) return null;
  if (gw.paymentId !== order.paymentId) return null;
  if (gw.orderId !== order.id) return null;
  let gwPaise;
  try { gwPaise = BigInt(gw.amountPaise); } catch { return null; }
  if (gwPaise !== BigInt(order.amountPaise)) return null;
  if (String(gw.currency || '').toUpperCase() !== order.currency) return null;

  const base = { gatewayStatus: String(gw.status || '') };
  switch (gw.status) {
    case 'OBSERVED_SUCCESS':
    case 'RECONCILED':
      // Only a UPI credit is money received; COD / counter events never mark an order paid.
      if (gw.method !== 'UPI') return null;
      return { ...base, status: OrderStatus.PAID, settlementState: gw.settlementState || gw.status };
    case 'SUCCESS':
      // Cash on delivery / counter outcome: this store never offers those, so it is ignored.
      return null;
    case 'MANUAL_REVIEW':
      return { ...base, status: OrderStatus.REVIEW, settlementState: 'MANUAL_REVIEW' };
    case 'FAILED':
      return { ...base, status: OrderStatus.FAILED };
    case 'EXPIRED':
      return { ...base, status: OrderStatus.EXPIRED };
    case 'CANCELLED':
      return { ...base, status: OrderStatus.CANCELLED };
    default:
      return { ...base, status: OrderStatus.PENDING };
  }
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) || '';
  return headers?.[name] || '';
}

/**
 * Verifies an HMAC-SHA256 signature over "<timestamp>.<raw body>" (the gateway's V2 webhook
 * scheme), so the timestamp cannot be swapped, and rejects messages outside the tolerance window.
 * The default tolerance covers the gateway's webhook retry schedule; replays are harmless because
 * processing is an idempotent, authenticated read-back.
 * `headers` may be a plain object (node:http) or a Headers instance (fetch / Vercel).
 */
export function verifyWebhookSignature(rawBody, headers, secret, { toleranceMs = 2 * 60 * 60 * 1000, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'webhook secret not configured' };
  const sigHeader = String(headerValue(headers, 'x-gateway-signature-v2'));
  const timestamp = String(headerValue(headers, 'x-gateway-timestamp'));
  if (!sigHeader.startsWith('sha256=') || !/^\d{10,16}$/.test(timestamp)) {
    return { ok: false, reason: 'missing signature or timestamp' };
  }
  if (Math.abs(now - Number(timestamp)) > toleranceMs) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  const presented = Buffer.from(sigHeader.slice('sha256='.length), 'hex');
  if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
    return { ok: false, reason: 'bad signature' };
  }
  return { ok: true };
}

/** A 12-digit UPI reference number, or null. */
export function cleanUtr(value) {
  const utr = String(value ?? '').trim();
  return /^\d{12}$/.test(utr) ? utr : null;
}
