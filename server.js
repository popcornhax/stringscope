// Minimal static file server (no dependencies): `node server.js [port] [--lan] [--root dir]`.
// --lan also listens on your local network so a phone or tablet on the same Wi-Fi can open it.
// --root serves another folder, such as the built site in _site/ (`npm run preview`).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const args = process.argv.slice(2);
const rootArg = args.includes('--root') ? args[args.indexOf('--root') + 1] : null;
const root = rootArg ? resolve(rootArg) + sep : fileURLToPath(new URL('.', import.meta.url));
const lan = args.includes('--lan');
const port = Number(args.find((a) => /^\d+$/.test(a)) || process.env.PORT || 5178);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.stl': 'model/stl',
  '.obj': 'text/plain',
  '.ply': 'application/octet-stream',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep) && path !== root) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`StringScope running at http://localhost:${port}`);
  if (!lan) return;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: http://${a.address}:${port}`);
    }
  }
  console.log('  (plain http on the LAN: microphone and offline install need https or localhost)');
});
