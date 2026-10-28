#!/usr/bin/env node
/**
 * Makes this PC's gateway reachable from the internet and keeps the online store in step with it.
 *
 * The public address points at the checkout portal (port 7000), which serves the customer checkout
 * pages and forwards /api/* to the payment API, so one address serves customers, the observer phone
 * and the online store (Vercel). This script:
 *   1. opens a Cloudflare quick tunnel (no account needed) — or, with --url, uses an address you
 *      already route to http://localhost:7000 yourself (named Cloudflare tunnel, your own domain);
 *   2. tells the store that address (when linked with store:configure --store-url);
 *   3. writes the pairing QR page for the observer phone;
 *   4. every minute asks the store to re-check open orders against the gateway (safety net for
 *      lost webhooks that does not depend on the hosting plan's cron limits).
 *
 * A quick-tunnel address changes every time this restarts: the store is updated automatically, but
 * the phone must be paired again. Use --url with a fixed address to avoid that.
 *
 * Needs `cloudflared` on PATH unless --url is given (Windows: winget install --id Cloudflare.cloudflared).
 * Usage: npm run observer:tunnel            or   npm run observer:tunnel -- --url https://pay.example.com
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portalPort = Number(process.env.CHECKOUT_PORTAL_PORT || 7000);
const SYNC_EVERY_MS = 60 * 1000;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function readStoreLink() {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(rootDir, 'data', '.secrets', 'rupee_store.json'), 'utf8'));
    return creds.storeUrl && creds.storeAdminToken ? creds : null;
  } catch {
    return null;
  }
}

async function storeCall(link, route, body) {
  const res = await fetch(`${link.storeUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${link.storeAdminToken}` },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(30000)
  });
  return { status: res.status, ok: res.ok, body: await res.json().catch(() => ({})) };
}

/** Retries for a while: a brand-new quick-tunnel hostname takes a few seconds to resolve everywhere. */
async function linkStore(link, gatewayUrl) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await storeCall(link, '/api/admin/link', { gatewayUrl });
      if (res.ok) {
        console.log(`✔ ${link.storeUrl} now sends customers to ${gatewayUrl}`);
        return true;
      }
      console.warn(`  Store link attempt ${attempt} failed (HTTP ${res.status}): ${res.body.error || ''}`);
      if (res.status === 401 || res.status === 400) return false;
    } catch (err) {
      console.warn(`  Store link attempt ${attempt} failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  console.error('✖ Could not update the store. Customers cannot pay until this succeeds; restart this command.');
  return false;
}

function startSyncLoop(link) {
  const tick = async () => {
    try {
      const res = await storeCall(link, '/api/admin/sync');
      if (!res.ok) console.warn(`  Order re-check failed (HTTP ${res.status}): ${res.body.error || ''}`);
      else if (res.body.checked) console.log(`  Re-checked ${res.body.checked} open order(s) with the gateway`);
    } catch (err) {
      console.warn(`  Order re-check failed: ${err.message}`);
    }
  };
  setInterval(tick, SYNC_EVERY_MS).unref?.();
  tick();
}

async function goLive(publicUrl) {
  const link = readStoreLink();
  if (link) {
    await linkStore(link, publicUrl);
    startSyncLoop(link);
  } else {
    console.log('  (No online store linked yet. Link one with: npm run store:configure -- ... --store-url <https://your-store> --admin-token <token>)');
  }
  spawnSync(process.execPath, [path.join(rootDir, 'scripts', 'observer-pairing.js'), '--url', publicUrl], { stdio: 'inherit', cwd: rootDir });
  console.log('\nKeep this window open while you accept payments. Press Ctrl+C to stop.');
}

const fixedUrl = arg('url');
if (fixedUrl) {
  let url;
  try { url = new URL(fixedUrl); } catch {}
  if (!url || url.protocol !== 'https:') {
    console.error('--url must be an https:// address that routes to http://localhost:7000 on this PC');
    process.exit(1);
  }
  console.log(`Using fixed public address ${url.origin} (it must route to http://localhost:${portalPort})`);
  await goLive(url.origin);
  // Keep the process alive for the sync loop.
  setInterval(() => {}, 1 << 30);
} else {
  const tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${portalPort}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });

  tunnel.on('error', err => {
    console.error(`Could not start cloudflared (${err.message}).`);
    console.error('Install it first. Windows: winget install --id Cloudflare.cloudflared   macOS: brew install cloudflared');
    process.exit(1);
  });

  let started = false;
  const onOutput = chunk => {
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
    if (!match || started) return;
    started = true;
    console.log(`\n✔ Tunnel ready: ${match[0]} -> http://localhost:${portalPort}`);
    // Give Cloudflare's edge a few seconds to start routing the new hostname.
    setTimeout(() => goLive(match[0]), 5000);
  };
  tunnel.stdout.on('data', onOutput);
  tunnel.stderr.on('data', onOutput);
  tunnel.on('exit', code => {
    console.log(`cloudflared exited (${code}).`);
    process.exit(code || 0);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      tunnel.kill();
      process.exit(0);
    });
  }
}
