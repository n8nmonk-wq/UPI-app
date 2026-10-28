import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '../../..');

/** Credentials written by `npm run store:configure` (data/.secrets is gitignored). */
export const CREDENTIALS_FILE = path.join(ROOT_DIR, 'data', '.secrets', 'rupee_store.json');

export { PRODUCT } from './product.js';

function readCredentialsFile() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function trimSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * Resolves runtime configuration. Environment variables win over the credentials file so a
 * deployment can inject secrets without touching disk.
 */
export function loadConfig(overrides = {}) {
  const file = readCredentialsFile();
  const port = Number(overrides.port || process.env.RUPEE_STORE_PORT || 4000);
  return {
    port,
    bindHost: overrides.bindHost || process.env.YOUPI_BIND_HOST || '127.0.0.1',
    publicUrl: trimSlash(overrides.publicUrl || process.env.RUPEE_STORE_PUBLIC_URL || `http://localhost:${port}`),
    gatewayApiUrl: trimSlash(overrides.gatewayApiUrl || process.env.RUPEE_STORE_GATEWAY_API_URL
      || process.env.PAYMENT_API_INTERNAL_URL || `http://127.0.0.1:${process.env.PAYMENT_API_PORT || 6100}`),
    merchantId: overrides.merchantId || process.env.RUPEE_STORE_MERCHANT_ID || file.merchantId || '',
    merchantKey: overrides.merchantKey || process.env.RUPEE_STORE_MERCHANT_KEY || file.merchantKey || '',
    webhookSecret: overrides.webhookSecret || process.env.RUPEE_STORE_WEBHOOK_SECRET || file.webhookSecret || '',
    dbPath: overrides.dbPath || process.env.RUPEE_STORE_DB_PATH || path.join(ROOT_DIR, 'data', 'rupee-store.sqlite')
  };
}

export function isConfigured(config) {
  return Boolean(config.merchantId && config.merchantKey && config.webhookSecret);
}
