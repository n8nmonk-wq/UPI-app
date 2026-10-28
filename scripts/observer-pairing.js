#!/usr/bin/env node
/**
 * Builds a pairing QR for the Android observer app that points at a public HTTPS address of
 * this gateway (for example a Cloudflare quick tunnel), because in localhost mode the admin
 * panel's QR would send the phone to "localhost", which the phone cannot reach.
 *
 * Usage: npm run observer:pair -- --url https://something.trycloudflare.com
 * Writes data/observer-pairing.html (gitignored). Anyone holding the token can pair a device
 * and report payments, so do not share the page or a screenshot of it; delete it after pairing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(rootDir, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envFile); } catch {}
}

const { resolveSecret } = await import('@youpi/common');
const { generateQrSvg } = await import('@youpi/core');

const i = process.argv.indexOf('--url');
const rawUrl = (i !== -1 ? process.argv[i + 1] : '') || '';
let url;
try {
  url = new URL(rawUrl.trim());
} catch {
  console.error('Give the public HTTPS address of the gateway API, for example:\n  npm run observer:pair -- --url https://something.trycloudflare.com');
  process.exit(1);
}
if (url.protocol !== 'https:') {
  console.error('The phone app only talks to the gateway over https://. Start a tunnel first (see docs/RUPEE_STORE.md).');
  process.exit(1);
}
const serverUrl = url.origin;

// Same secret and payload format as GET /api/v1/admin/sms-gateway/pair-qr.
const token = resolveSecret('android_enrollment_secret', 'ANDROID_ENROLLMENT_SECRET');
const expiresAt = Date.now() + 10 * 60 * 1000;
const payload = JSON.stringify({
  version: 'v1',
  type: 'YOUPI_SMS_GATEWAY_PAIR',
  serverUrl,
  gatewayUrl: serverUrl,
  apiBaseUrl: serverUrl,
  sessionId: crypto.randomUUID(),
  token,
  enrollmentToken: token,
  merchantId: '00000000-0000-0000-0000-000000000001',
  createdAt: Date.now(),
  expiresAt
});

// Make sure the phone will actually reach the payment API through this address.
try {
  const res = await fetch(`${serverUrl}/api/v1/payments/${crypto.randomUUID()}`, { signal: AbortSignal.timeout(8000) });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 404 || !String(body.error || '').startsWith('Payment session not found')) {
    throw new Error(`answered, but not as the payment API (HTTP ${res.status})`);
  }
  console.log(`✔ ${serverUrl} reaches the payment API`);
} catch (err) {
  console.warn(`! Could not reach the payment API through ${serverUrl} (${err.message}). Check the tunnel points at http://localhost:7000.`);
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pair observer phone</title>
<style>body{font:16px system-ui,sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#14181f}
.qr{background:#fff;display:inline-block;padding:16px;border:1px solid #ddd;border-radius:12px}
code{background:#f1f3f5;padding:2px 6px;border-radius:4px;word-break:break-all}.warn{color:#b45309}</style></head>
<body><h1>Pair the observer phone</h1>
<p>In the YOUPI observer app tap <b>Scan pairing QR</b> and scan this code. It expires at ${new Date(expiresAt).toLocaleTimeString()}.</p>
<div class="qr">${generateQrSvg(payload, 300)}</div>
<p>Or type these in the app:</p>
<p>Gateway URL: <code>${serverUrl}</code><br>Enrollment token: <code>${token}</code></p>
<p class="warn">Anyone with this token can pair a phone and report payments. Close and delete this file after pairing.</p>
</body></html>`;

const out = path.join(rootDir, 'data', 'observer-pairing.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html, { mode: 0o600 });
console.log(`✔ Pairing page written to ${out}`);
console.log('  Open it in your browser and scan the QR with the observer app (valid 10 minutes).');
