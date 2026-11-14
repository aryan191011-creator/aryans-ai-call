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

const TTS_UPSTREAM =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent';

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

let t0 = Date.now();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // A request line per hit is the whole point: when someone reports "the
  // preview is dead", this answers the only question that matters — did their
  // browser ever reach us, or did it die before that? The UA is logged because
  // "GET / from curl" and "GET / from a real browser" look identical otherwise,
  // and only the second one can render a page.
  const ua = String(req.headers['user-agent'] || 'no-ua').slice(0, 60);
  const seen = () =>
    console.log(
      `[http] ${req.method} ${url.pathname} → ${res.statusCode} ` +
        `(${Date.now() - t0}ms up) "${ua}"`
    );
  res.on('finish', seen);

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

  if (url.pathname === '/tts') {
    // Voice audition for the settings sheet. Only exists in keysafe mode, where the
    // browser has no key of its own: without this the picker would only be able to
    // preview voices in the weaker, key-in-the-browser mode.
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'POST only' } }));
      return;
    }
    if (!PROXY || !GEMINI_API_KEY) {
      res.writeHead(409, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: { message: 'server is not in keysafe mode — the page should call Google directly' } })
      );
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) { res.writeHead(413).end('too big'); return; }  // a prompt, not a payload
      chunks.push(c);
    }
    try {
      const up = await fetch(TTS_UPSTREAM, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: Buffer.concat(chunks),
      });
      const text = await up.text();
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' });
      res.end(text);
    } catch (e) {
      // Never a bare 500: the sheet shows this string, and "fetch failed" tells the
      // user nothing while "no egress to generativelanguage.googleapis.com" tells
      // them the sandbox/host is the problem, not their key.
      res.writeHead(502, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: { message: `upstream ${e.message}` } })
      );
    }
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
    let upstreamErr = '';
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
      // A bare 1006 is useless to whoever is debugging a silent call. The real
      // cause lives on the error event (DNS/refused/TLS), so carry it across.
      const detail = String(reason || '') || upstreamErr;
      console.error('[relay] upstream closed:', code, detail);
      try {
        browser.send(JSON.stringify({ relayError: { code, reason: detail || 'upstream closed' } }));
      } catch {}
      browser.close();
    });
    upstream.on('error', (e) => {
      upstreamErr = e.message;
      console.error('[relay] upstream error:', e.message);
    });
    browser.on('close', () => upstream.close());
  });
  console.log('[relay] WebSocket proxy mounted at /relay');
}

server.listen(PORT, HOST, () => {
  console.log(`\n  aryans-ai-call  ·  http://${HOST}:${PORT}`);
  console.log(`  mode: ${PROXY ? 'keysafe (server holds the key)' : 'direct (browser holds the key)'}\n`);
});
