/**
 * aryans-ai-call — Phase 0 server.
 *
 * Two jobs, deliberately boring:
 *   1. serve ./web as static files (no bundler, no deps)
 *   2. optionally relay WebSocket audio to Gemini Live so the API key can stay
 *      on the server instead of in the browser (KEYSAFE=1)
 *
 * Direct mode (default): the browser opens the WebSocket to Google itself.
 *   That is Google's officially supported "client-to-server" approach and it is
 *   the only mode that works with no server at all — but it puts your key in
 *   the page, so keep it to your own machine and never expose this on the open
 *   internet that way.
 * Keysafe mode: browser -> this server -> Google. Key stays in the env.
 *   Requires the optional `ws` package (npm i ws). Enable with PROXY=1.
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./web', import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PROXY = process.env.PROXY === '1';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const UPSTREAM =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta' +
  '.GenerativeService.BidiGenerateContent';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let wsLib = null;
if (PROXY) {
  if (!GEMINI_API_KEY) {
    console.error('[fatal] PROXY=1 needs GEMINI_API_KEY in the environment.');
    process.exit(1);
  }
  try {
    wsLib = await import('ws');
  } catch {
    console.error('[fatal] PROXY=1 needs the `ws` package. Run: npm install ws');
    process.exit(1);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proxy: PROXY, hasKey: Boolean(GEMINI_API_KEY) }));
    return;
  }
  if (url.pathname === '/config') {
    // Tells the page whether it may talk to Google directly or must use us.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keysafe: PROXY && Boolean(GEMINI_API_KEY) }));
    return;
  }

  let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '\\' || p === '.') p = '/index.html';
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) throw Object.assign(new Error('EISDIR'), { code: 'EISDIR' });
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      // getUserMedia requires a secure context; a proxied dev host is treated as
      // one only if we do not sandbox it away from its own origin features.
      'permissions-policy': 'microphone=(self)',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'EISDIR' ? 404 : err.code === 'ENOENT' ? 404 : 500);
    res.end('not found');
  }
});

if (PROXY) {
  const { WebSocketServer, WebSocket } = wsLib;
  const wss = new WebSocketServer({ server, path: '/relay' });
  wss.on('connection', (browser) => {
    const upstream = new WebSocket(`${UPSTREAM}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      headers: { 'x-goog-api-key': GEMINI_API_KEY },
    });
    const queue = [];
    upstream.on('open', () => {
      console.log('[relay] upstream open');
      while (queue.length) upstream.send(queue.shift());
    });
    browser.on('message', (msg) => {
      const data = msg.toString();
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else if (upstream.readyState === WebSocket.CONNECTING) queue.push(data);
    });
    upstream.on('message', (msg) => {
      if (browser.readyState === WebSocket.OPEN) browser.send(msg.toString());
    });
    upstream.on('close', (code, reason) => {
      try {
        browser.send(JSON.stringify({ relayError: { code, reason: String(reason) } }));
      } catch {}
      browser.close();
    });
    upstream.on('error', (e) => console.error('[relay] upstream error:', e.message));
    browser.on('close', () => upstream.close());
  });
  console.log('[relay] WebSocket proxy mounted at /relay');
}

server.listen(PORT, HOST, () => {
  console.log(`\n  aryans-ai-call  ·  http://${HOST}:${PORT}`);
  console.log(`  mode: ${PROXY ? 'keysafe (server holds the key)' : 'direct (browser holds the key)'}\n`);
});
