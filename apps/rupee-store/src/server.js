import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, isConfigured, CREDENTIALS_FILE } from './config.js';
import { PRODUCT, ORDER_ID_RE, formatRupees } from './product.js';
import { OrderStore, OrderStatus } from './orders.js';
import { GatewayClient, deriveOrderStatus, verifyWebhookSignature, cleanUtr } from './gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8']
};
const MAX_BODY_BYTES = 64 * 1024;
const SYNC_INTERVAL_MS = 3000;

function securityHeaders(publicUrl) {
  const headers = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  };
  if (publicUrl.startsWith('https://')) headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

/** Fixed-window per-IP limiter for order creation, so nobody can flood the gateway queue. */
class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  allow(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.start > this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      if (this.hits.size > 10000) this.hits.clear();
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function publicOrder(order) {
  return {
    orderId: order.id,
    product: PRODUCT.name,
    amount: formatRupees(order.amountPaise),
    currency: order.currency,
    status: order.status,
    settlementState: order.settlementState,
    utr: order.status === OrderStatus.PAID ? order.utr : null,
    createdAt: order.createdAt,
    paidAt: order.paidAt
  };
}

export class RupeeStoreServer {
  constructor(overrides = {}) {
    this.overrides = overrides;
    this.config = loadConfig(overrides);
    this.credentialsMtime = this.credentialsFileMtime();
    this.orders = new OrderStore(this.config.dbPath);
    this.gateway = new GatewayClient(this.config);
    this.orderLimiter = new RateLimiter(5, 60 * 1000);
    this.lastSync = new Map();
    this.headers = securityHeaders(this.config.publicUrl);
  }

  credentialsFileMtime() {
    try { return fs.statSync(CREDENTIALS_FILE).mtimeMs; } catch { return 0; }
  }

  /** Picks up credentials re-issued by `npm run store:configure` without a restart. */
  refreshCredentials() {
    const mtime = this.credentialsFileMtime();
    if (mtime === this.credentialsMtime) return;
    this.credentialsMtime = mtime;
    const next = loadConfig(this.overrides);
    Object.assign(this.config, { merchantId: next.merchantId, merchantKey: next.merchantKey, webhookSecret: next.webhookSecret });
  }

  send(res, status, body, extraHeaders = {}) {
    res.writeHead(status, {
      ...this.headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    });
    res.end(JSON.stringify(body));
  }

  /** Same-origin check for state-changing browser requests (CSRF defence on top of the JSON content type). */
  isSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const allowed = new Set([this.config.publicUrl, `http://localhost:${this.config.port}`, `http://127.0.0.1:${this.config.port}`]);
    return allowed.has(origin);
  }

  /**
   * Refreshes an order from an authenticated gateway read. With `throwOnError` a failed read
   * throws, so a webhook can answer non-2xx and the gateway retries it.
   */
  async syncFromGateway(order, { force = false, throwOnError = false } = {}) {
    if (!order?.paymentId || (order.status === OrderStatus.PAID && order.settlementState === 'RECONCILED')) return order;
    const last = this.lastSync.get(order.id) || 0;
    if (!force && Date.now() - last < SYNC_INTERVAL_MS) return order;
    this.lastSync.set(order.id, Date.now());
    try {
      const gw = await this.gateway.getPayment(order.paymentId);
      const next = deriveOrderStatus(order, gw);
      if (!next) {
        console.warn(`[Rupee Store] Gateway record for ${order.id} does not match the order; ignoring.`);
        return order;
      }
      if (next.status !== order.status || (next.settlementState && next.settlementState !== order.settlementState)) {
        const updated = this.orders.transition(order.id, next.status, { settlementState: next.settlementState });
        if (updated.status === OrderStatus.PAID && order.status !== OrderStatus.PAID) {
          console.log(`[Rupee Store] Order ${order.id} PAID (gateway status ${gw.status}).`);
        }
        return updated;
      }
    } catch (err) {
      console.warn(`[Rupee Store] Could not refresh ${order.id} from gateway: ${err.message}`);
      if (throwOnError) throw err;
    }
    return this.orders.get(order.id);
  }

  async handleCreateOrder(req, res) {
    if (!isConfigured(this.config)) {
      this.send(res, 503, { error: 'Store is not connected to the payment gateway yet. Run: npm run store:configure -- --upi <your-upi-id>' });
      return;
    }
    if (!this.isSameOrigin(req)) {
      this.send(res, 403, { error: 'Cross-origin request blocked' });
      return;
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      this.send(res, 415, { error: 'Content-Type must be application/json' });
      return;
    }
    const ip = req.socket.remoteAddress || 'unknown';
    if (!this.orderLimiter.allow(ip)) {
      this.send(res, 429, { error: 'Too many orders. Please wait a minute and try again.' }, { 'Retry-After': '60' });
      return;
    }
    await readRawBody(req); // body is ignored on purpose: price and product come from the server only

    const orderId = `R1-${crypto.randomBytes(16).toString('base64url')}`;
    const order = this.orders.create({ id: orderId, sku: PRODUCT.sku, amountPaise: PRODUCT.amountPaise, currency: PRODUCT.currency });
    try {
      const payment = await this.gateway.createPayment({
        orderId,
        amountPaise: order.amountPaise,
        currency: order.currency,
        returnUrl: `${this.config.publicUrl}/?order=${encodeURIComponent(orderId)}`,
        metadata: { sku: PRODUCT.sku }
      });
      if (!payment.paymentId || !payment.checkoutUrl) throw new Error('Gateway response missing paymentId/checkoutUrl');
      this.orders.attachPayment(orderId, payment.paymentId);
      this.send(res, 201, { orderId, checkoutUrl: payment.checkoutUrl });
    } catch (err) {
      this.orders.remove(orderId);
      console.warn(`[Rupee Store] Payment creation failed: ${err.message}`);
      const unavailable = err.code === 'OBSERVERS_UNHEALTHY';
      this.send(res, unavailable ? 503 : 502, {
        error: unavailable
          ? 'UPI payments are paused: the merchant payment observer (phone) is offline. Please try again shortly.'
          : 'Could not start the payment. Please try again.'
      });
    }
  }

  async handleGetOrder(res, orderId) {
    if (!ORDER_ID_RE.test(orderId)) {
      this.send(res, 404, { error: 'Order not found' });
      return;
    }
    let order = this.orders.get(orderId);
    if (!order) {
      this.send(res, 404, { error: 'Order not found' });
      return;
    }
    order = await this.syncFromGateway(order);
    this.send(res, 200, publicOrder(order));
  }

  async handleWebhook(req, res) {
    const raw = await readRawBody(req);
    const check = verifyWebhookSignature(raw, req.headers, this.config.webhookSecret);
    if (!check.ok) {
      console.warn(`[Rupee Store] Rejected webhook: ${check.reason}`);
      this.send(res, 401, { error: 'Invalid webhook signature' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      this.send(res, 400, { error: 'Invalid JSON' });
      return;
    }
    const deliveryId = String(req.headers['x-gateway-delivery-id'] || payload.deliveryId || '');
    let order = typeof payload.orderId === 'string' ? this.orders.get(payload.orderId) : null;
    if (!order || order.paymentId !== payload.paymentId) {
      // Not ours (e.g. another integration on the same merchant). Acknowledge so it is not retried.
      this.send(res, 200, { received: true, ignored: true });
      return;
    }
    if (deliveryId && this.orders.hasDelivery(deliveryId)) {
      this.send(res, 200, { received: true, duplicate: true });
      return;
    }

    // The signed webhook tells us *when* to look; the authoritative gateway read decides *what* happened.
    try {
      order = await this.syncFromGateway(order, { force: true, throwOnError: true });
    } catch {
      // Not recorded as processed, so the gateway's retry gets a second chance.
      this.send(res, 503, { error: 'Gateway read-back failed; retry later' });
      return;
    }
    const utr = cleanUtr(payload.utr);
    if (order.status === OrderStatus.PAID && utr) {
      order = this.orders.transition(order.id, OrderStatus.PAID, { utr });
    }
    if (deliveryId) this.orders.recordDelivery(deliveryId, order.id, String(payload.event || ''));
    this.send(res, 200, { received: true, status: order.status });
  }

  serveStatic(res, pathname) {
    const [file, type] = STATIC_FILES[pathname];
    const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { ...this.headers, 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(body);
  }

  createServer() {
    return http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://store.local');
        const { pathname } = url;
        const method = req.method.toUpperCase();
        if (pathname.startsWith('/api/')) this.refreshCredentials();

        if (method === 'GET' && pathname === '/health') {
          this.send(res, 200, { status: 'UP', service: 'rupee-store', configured: isConfigured(this.config) });
          return;
        }
        if (method === 'GET' && STATIC_FILES[pathname]) {
          this.serveStatic(res, pathname);
          return;
        }
        if (method === 'GET' && pathname === '/api/product') {
          this.send(res, 200, {
            sku: PRODUCT.sku,
            name: PRODUCT.name,
            description: PRODUCT.description,
            amount: formatRupees(PRODUCT.amountPaise),
            currency: PRODUCT.currency,
            ready: isConfigured(this.config)
          });
          return;
        }
        if (method === 'POST' && pathname === '/api/orders') {
          await this.handleCreateOrder(req, res);
          return;
        }
        const match = /^\/api\/orders\/([^/]+)$/.exec(pathname);
        if (method === 'GET' && match) {
          await this.handleGetOrder(res, decodeURIComponent(match[1]));
          return;
        }
        if (method === 'POST' && pathname === '/api/webhook') {
          await this.handleWebhook(req, res);
          return;
        }
        this.send(res, 404, { error: 'Not found' });
      } catch (err) {
        if (!res.headersSent) this.send(res, err.status || 500, { error: err.status === 413 ? err.message : 'Internal error' });
        if (!err.status) console.error('[Rupee Store] Unhandled error:', err);
      }
    });
  }
}
