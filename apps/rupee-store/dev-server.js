#!/usr/bin/env node
/**
 * Minimal local runner that behaves like the Vercel deployment: serves public/ and routes /api/*
 * to the Vercel Functions in api/ using Vercel's file-system routing (api/orders/index.js ->
 * /api/orders, api/orders/[id].js -> /api/orders/:id) and the same `export default { fetch }`
 * handlers. For local end-to-end testing; `vercel dev` works too if you have the Vercel CLI.
 *
 * Usage: DATABASE_URL=... STORE_ADMIN_TOKEN=... STORE_ENCRYPTION_KEY=... node dev-server.js [port]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const apiDir = path.join(here, 'api');
const port = Number(process.argv[2] || process.env.PORT || 8888);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function listFunctions(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFunctions(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/** api/orders/[id].js -> /^\/api\/orders\/([^/]+)$/ ; api/orders/index.js -> /^\/api\/orders$/ */
function routeFor(file) {
  const rel = path.relative(here, file).split(path.sep).join('/').replace(/\.js$/, '').replace(/\/index$/, '');
  const pattern = rel.split('/').map(seg => (/^\[.+\]$/.test(seg) ? '([^/]+)' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('\\/');
  return { re: new RegExp(`^\\/${pattern}$`), dynamic: rel.includes('[') };
}

const routes = [];
for (const file of listFunctions(apiDir)) {
  const mod = await import(pathToFileURL(file).href);
  routes.push({ ...routeFor(file), handler: mod.default });
}
// Static segments win over dynamic ones, as on Vercel.
routes.sort((a, b) => Number(a.dynamic) - Number(b.dynamic));

http.createServer(async (req, res) => {
  // Like Vercel, the function sees the URL the client actually used.
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${port}`}`);
  try {
    const route = routes.find(r => r.re.test(url.pathname));
    if (route) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers(Object.entries(req.headers).filter(([, v]) => typeof v === 'string'));
      headers.set('x-real-ip', req.socket.remoteAddress || 'unknown');
      const request = new Request(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks)
      });
      const response = await route.handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const full = path.resolve(publicDir, file);
    if (full.startsWith(publicDir + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
      res.end(fs.readFileSync(full));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"Not found"}');
  } catch (err) {
    console.error('[dev-server]', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"Internal error"}');
  }
}).listen(port, '127.0.0.1', () => console.log(`[dev-server] Vercel-style store on http://localhost:${port}`));
