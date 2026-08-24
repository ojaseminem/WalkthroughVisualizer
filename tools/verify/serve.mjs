import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
};

/**
 * Minimal static server for the verification run.
 *
 * The harness serves the build itself rather than shelling out to `vite preview`
 * and polling with wait-on. That removes a background process, a fixed port, and
 * a startup race from CI — three things that were only ever there to hand the
 * browser a URL.
 */
export function serve(dir) {
  const root = resolve(dir);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';

      // Contain every request inside the served directory.
      const target = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (target !== root && !target.startsWith(root + sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }

      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(target).pipe(res);
    } catch (err) {
      res.writeHead(500).end(String(err && err.message));
    }
  });

  return new Promise((res2, rej) => {
    server.on('error', rej);
    // Port 0 asks the OS for a free port, so parallel runs never collide.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      res2({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
