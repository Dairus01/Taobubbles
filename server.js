'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const UPSTREAM_URL = 'https://taostats.io/api/dtao/dtaoSubnets?order=market_cap_desc';
const CACHE_TTL_MS = 30_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

let cache = {
  expiresAt: 0,
  status: 200,
  body: null,
};

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(res, statusCode, payload) {
  setSecurityHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res) {
  const requestPath = req.url === '/' ? '/index.html' : req.url;
  let normalizedPath;
  try {
    normalizedPath = path.normalize(decodeURIComponent(requestPath));
  } catch {
    sendJson(res, 400, { error: 'Invalid URL encoding' });
    return;
  }
  const safePath = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;
  const filePath = path.resolve(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    setSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });

    const stream = fs.createReadStream(filePath);
      stream.on('error', () => {
        if (!res.headersSent) {
          setSecurityHeaders(res);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ error: 'Read error' }));
      });
    stream.pipe(res);
  });
}

async function handleSubnetProxy(res) {
  const now = Date.now();
  if (cache.body && cache.expiresAt > now) {
    setSecurityHeaders(res);
    res.writeHead(cache.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(cache.body);
    return;
  }

  try {
    const upstream = await fetch(UPSTREAM_URL, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TAObubbles/1.0 (+local-proxy)',
      },
    });

    const body = await upstream.text();
    cache = {
      expiresAt: now + CACHE_TTL_MS,
      status: upstream.status,
      body,
    };

    setSecurityHeaders(res);
    res.writeHead(upstream.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    sendJson(res, 502, { error: 'Upstream fetch failed' });
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    sendJson(res, 400, { error: 'Invalid request URL' });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/api/subnets') {
    await handleSubnetProxy(res);
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`TAObubbles server running at http://${HOST}:${PORT}`);
});
