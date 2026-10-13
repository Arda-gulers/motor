// Static dev server with no-store caching, plus POST /shot?name=x to save a canvas capture.
// Usage: node tools/serve.mjs [port] [shotsDir]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = +process.argv[2] || 8840;
const shots = path.resolve(process.argv[3] || path.join(root, 'tools', 'shots'));
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/shot') {
    const name = (url.searchParams.get('name') || 'shot').replace(/[^\w.-]/g, '_');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      fs.mkdirSync(shots, { recursive: true });
      fs.writeFileSync(path.join(shots, name + '.jpg'), Buffer.concat(chunks));
      res.end('ok');
    });
    return;
  }
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end('not found'); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log('serving ' + root + ' on http://localhost:' + port + ' shots -> ' + shots));
