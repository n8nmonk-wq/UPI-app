#!/usr/bin/env node
/**
 * Connects the one-page ₹1 store (apps/rupee-store) to the running gateway:
 *   - sets your receiving UPI ID (VPA) and payee name on the default merchant
 *   - points the merchant webhook at the store
 *   - issues a fresh merchant API key and webhook signing secret
 *   - saves both to data/.secrets/rupee_store.json (gitignored, owner-only permissions)
 *
 * Usage: npm run store:configure -- --upi yourname@okhdfcbank [--name "Your Name"]
 *
 * Online store (Vercel): add --store-url https://<your-project>.vercel.app --admin-token <STORE_ADMIN_TOKEN>.
 * The webhook then points at the online store and the fresh credentials are sent to it over HTTPS
 * (authenticated with the admin token), so they never need to be copied by hand.
 * The gateway must be running (npm run dev / npm start) when you run this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(rootDir, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(envFile); } catch {}
}

const { getAdminToken, isValidVpa } = await import('@youpi/common');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const upiId = (arg('upi') || process.env.MERCHANT_UPI_ID || '').trim();
const payeeName = (arg('name') || process.env.MERCHANT_PAYEE_NAME || '').trim();
const businessName = (arg('business') || process.env.MERCHANT_BUSINESS_NAME || 'One Rupee Store').trim();
const apiUrl = (process.env.RUPEE_STORE_GATEWAY_API_URL || `http://127.0.0.1:${process.env.PAYMENT_API_PORT || 6100}`).replace(/\/+$/, '');
const storePort = Number(process.env.RUPEE_STORE_PORT || 4000);
const storeUrl = (arg('store-url') || '').trim().replace(/\/+$/, '');
const storeAdminToken = (arg('admin-token') || '').trim();
const webhookUrl = process.env.RUPEE_STORE_WEBHOOK_URL
  || (storeUrl ? `${storeUrl}/api/webhook` : `http://127.0.0.1:${storePort}/api/webhook`);

if (storeUrl) {
  let parsed;
  try { parsed = new URL(storeUrl); } catch {}
  const localTest = parsed && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (!parsed || (parsed.protocol !== 'https:' && !localTest)) {
    console.error('--store-url must be the https:// address of your online store (e.g. https://<project>.vercel.app)');
    process.exit(1);
  }
  if (storeAdminToken.length < 32) {
    console.error('--admin-token is required with --store-url (the STORE_ADMIN_TOKEN set on the store)');
    process.exit(1);
  }
}

if (!upiId || !isValidVpa(upiId)) {
  console.error('Give your UPI ID, for example:\n  npm run store:configure -- --upi yourname@okhdfcbank --name "Your Name"');
  process.exit(1);
}

const adminToken = getAdminToken();

/** Brings an older .env (copied before the store existed) up to the hardened settings. */
function patchEnvFile() {
  if (!fs.existsSync(envFile)) return [];
  let text = fs.readFileSync(envFile, 'utf8');
  const changes = [];
  const published = /^ANDROID_ENROLLMENT_SECRET=android_pairing_enrollment_secret_key_32_chars\s*$/m;
  if (published.test(text)) {
    text = text.replace(published, '# ANDROID_ENROLLMENT_SECRET=  (removed: was a public example value; a random secret is generated)');
    changes.push('removed the public example ANDROID_ENROLLMENT_SECRET');
  }
  for (const [key, value] of [['YOUPI_REQUIRE_MERCHANT_KEY', 'true'], ['YOUPI_ALLOW_PRIVATE_WEBHOOKS', 'true']]) {
    if (!new RegExp(`^${key}=`, 'm').test(text)) {
      text += `${text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
      changes.push(`added ${key}=${value}`);
    }
  }
  if (changes.length) fs.writeFileSync(envFile, text);
  return changes;
}

async function call(method, route, body) {
  let res;
  try {
    res = await fetch(`${apiUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    });
  } catch (err) {
    throw new Error(`Cannot reach the gateway at ${apiUrl} (${err.message}). Start it first with: npm run dev`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route} failed (HTTP ${res.status}): ${data.error || JSON.stringify(data)}`);
  return data;
}

const envChanges = patchEnvFile();
if (envChanges.length) {
  for (const change of envChanges) console.log(`.env: ${change}`);
  console.log('\nThe gateway must load these settings first: stop it (Ctrl+C), start it again (npm run dev),');
  console.log('then run this same command again.');
  process.exit(2);
}

const settings = await call('POST', '/api/v1/admin/all-settings', {
  upiId,
  payeeName: payeeName || undefined,
  businessName,
  webhookUrl
});
const secret = await call('POST', '/api/v1/admin/webhook-secret/rotate', {});
const key = await call('POST', '/api/v1/admin/merchant-key/rotate', {});

const merchantId = key.merchantId || secret.merchantId || settings.merchantId;
const credentials = {
  merchantId,
  merchantKey: key.merchantKey,
  webhookSecret: secret.webhookSecret,
  ...(storeUrl ? { storeUrl, storeAdminToken } : {}),
  updatedAt: new Date().toISOString()
};
if (!credentials.merchantId || !credentials.merchantKey || !credentials.webhookSecret) {
  console.error('Gateway did not return a complete credential set:', { merchantId, hasKey: Boolean(key.merchantKey), hasSecret: Boolean(secret.webhookSecret) });
  process.exit(1);
}

const secretsDir = path.join(rootDir, 'data', '.secrets');
fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
const file = path.join(secretsDir, 'rupee_store.json');
fs.writeFileSync(file, JSON.stringify(credentials, null, 2), { mode: 0o600 });
try { fs.chmodSync(file, 0o600); } catch {}

if (storeUrl) {
  // The previous key stopped working when it was rotated above, so the store must get the new one now.
  let res;
  try {
    res = await fetch(`${storeUrl}/api/admin/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${storeAdminToken}` },
      body: JSON.stringify({ merchantId, merchantKey: credentials.merchantKey, webhookSecret: credentials.webhookSecret }),
      signal: AbortSignal.timeout(20000)
    });
  } catch (err) {
    console.error(`Could not reach the store at ${storeUrl} (${err.message}). Run this command again once it is reachable.`);
    process.exit(1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`The store refused the link (HTTP ${res.status}): ${body.error || 'unknown error'}. Fix that and run this command again.`);
    process.exit(1);
  }
  console.log(`\n✔ Online store ${storeUrl} received the new merchant credentials`);
  if (!body.linked) console.log(`  ${body.reason} Start the public tunnel next: npm run observer:tunnel`);
}

const upi = await call('GET', '/api/v1/admin/upi-settings');
console.log('\n✔ Store connected to the gateway');
console.log(`  Receiving UPI ID : ${upi.upiId} (${upi.payeeName})`);
console.log(`  Webhook URL      : ${webhookUrl}`);
console.log(`  Credentials      : ${path.relative(rootDir, file)} (keep this file private)`);
if (!storeUrl) console.log('\nThe store picks up the new credentials automatically; no restart needed.');
