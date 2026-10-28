import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RupeeStoreServer } from './server.js';
import { ROOT_DIR, isConfigured } from './config.js';

if (!process.env.BASE_PAYMENT_API_URL && typeof process.loadEnvFile === 'function') {
  const rootEnv = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(rootEnv)) {
    try { process.loadEnvFile(rootEnv); } catch {}
  }
}

export function startRupeeStore(overrides = {}) {
  const store = new RupeeStoreServer(overrides);
  const server = store.createServer();
  return new Promise(resolve => {
    const instance = server.listen(store.config.port, store.config.bindHost, () => {
      console.log(`[Rupee Store] One-page ₹1 store online at ${store.config.publicUrl}`);
      if (!isConfigured(store.config)) {
        console.warn('[Rupee Store] Not connected to the gateway yet. Run: npm run store:configure -- --upi <your-upi-id>');
      }
      resolve({
        store,
        port: store.config.port,
        close: () => new Promise(cb => instance.close(() => { store.orders.close(); cb(); }))
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startRupeeStore();
}
