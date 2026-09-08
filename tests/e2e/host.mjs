import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { buildApp } from '../../dist/server/server/app.js';
import { configSchema } from '../../dist/server/ops/config.js';
const dir = resolve('.reviewloop/e2e');
mkdirSync(dir, { recursive: true, mode: 0o700 });
const key = join(dir, 'test-key.pem'),
  cert = join(dir, 'test-cert.pem');
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout',
    key,
    '-out',
    cert,
  ],
  { stdio: 'ignore' },
);
chmodSync(key, 0o600);
const { app } = await buildApp({
  dataDir: dir,
  demo: true,
  config: configSchema.parse({ publicOrigin: 'https://localhost:4319' }),
});
await app.listen({ host: '127.0.0.1', port: 4318 });
const proxy = https.createServer(
  { key: readFileSync(key), cert: readFileSync(cert) },
  (req, res) => {
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: 4318,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
    res.on('close', () => upstream.destroy());
  },
);
await new Promise((resolve) => proxy.listen(4319, '127.0.0.1', resolve));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
