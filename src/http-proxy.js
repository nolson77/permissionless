// ─────────────────────────────────────────────────────────────────────────────
// src/http-proxy.js — Permissionless HTTP MCP Proxy
//
// Sits between Claude Desktop and any HTTP-based MCP server (Linear, etc.),
// logging every tool call to activity_log.json before forwarding it.
//
// ── HOW IT WORKS ──────────────────────────────────────────────────────────────
// Claude Desktop ──POST──► Proxy (localhost:3001) ──POST──► Real MCP server
//                ◄─response─                      ◄─response─
//
// Claude Desktop is configured to point at http://localhost:3001/proxy/<service>
// instead of the real MCP URL. The proxy logs the call and forwards everything
// through transparently — headers, auth, body — unchanged.
//
// ── ADDING A NEW HTTP-BASED MCP ───────────────────────────────────────────────
// 1. Add it to SERVICES below with its real URL
// 2. In claude_desktop_config.json, set "url" to:
//    http://localhost:3001/proxy/<service-name>
//    Keep your "headers" (Authorization etc.) as-is — they pass through.
//
// ── CURRENT SERVICES ──────────────────────────────────────────────────────────
// linear → https://mcp.linear.app/mcp
// ─────────────────────────────────────────────────────────────────────────────

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PROXY_PORT   = 3001;
const BASE_DIR     = path.join(__dirname, '..');
const ACTIVITY_LOG = path.join(BASE_DIR, 'activity_log.json');

// ── Service registry ──────────────────────────────────────────────────────────
// Add any HTTP-based MCP server here.
const SERVICES = {
  linear: { url: 'https://mcp.linear.app/mcp' },
};

// ── Activity log helpers ───────────────────────────────────────────────────────

function loadLog() {
  try { return JSON.parse(fs.readFileSync(ACTIVITY_LOG, 'utf8')); }
  catch { return { events: [] }; }
}

function appendEvent(event) {
  const log = loadLog();
  log.events.unshift(event);
  if (log.events.length > 2000) log.events = log.events.slice(0, 2000);
  try { fs.writeFileSync(ACTIVITY_LOG, JSON.stringify(log, null, 2)); }
  catch (e) { process.stderr.write(`[http-proxy] Write error: ${e.message}\n`); }
}

function updateEventStatus(eventId, status, errorMsg) {
  try {
    const log = loadLog();
    const idx = log.events.findIndex(e => e.id === eventId);
    if (idx >= 0) {
      log.events[idx].status       = status;
      log.events[idx].completed_at = new Date().toISOString();
      if (errorMsg) log.events[idx].error = errorMsg;
      fs.writeFileSync(ACTIVITY_LOG, JSON.stringify(log, null, 2));
    }
  } catch {}
}

function newId() {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Request forwarding ────────────────────────────────────────────────────────

function forwardRequest(req, res, targetUrl, body, eventId) {
  const target  = new URL(targetUrl);
  const isHttps = target.protocol === 'https:';

  // Build forwarded headers — replace host, strip hop-by-hop
  const headers = { ...req.headers };
  headers['host'] = target.hostname;
  delete headers['connection'];
  delete headers['transfer-encoding'];

  const options = {
    hostname: target.hostname,
    port:     target.port || (isHttps ? 443 : 80),
    path:     target.pathname + (target.search || ''),
    method:   req.method,
    headers,
  };

  const transport = isHttps ? https : http;

  const proxyReq = transport.request(options, proxyRes => {
    const contentType = proxyRes.headers['content-type'] || '';

    // Forward all response headers
    res.writeHead(proxyRes.statusCode, proxyRes.headers);

    if (contentType.includes('text/event-stream')) {
      // ── SSE streaming response ─────────────────────────────────────────────
      // Pipe directly through; parse events on the fly to update event status.
      let sseBuffer = '';

      proxyRes.on('data', chunk => {
        res.write(chunk);

        // Attempt to parse SSE events for status tracking
        sseBuffer += chunk.toString();
        const parts = sseBuffer.split('\n\n');
        sseBuffer = parts.pop(); // keep incomplete trailing event

        for (const part of parts) {
          const dataLine = part.split('\n').find(l => l.startsWith('data: '));
          if (dataLine && eventId) {
            try {
              const rpc = JSON.parse(dataLine.slice(6));
              if (rpc.id != null) {
                updateEventStatus(
                  eventId,
                  rpc.error ? 'error' : 'success',
                  rpc.error?.message,
                );
                eventId = null; // only update once
              }
            } catch {}
          }
        }
      });

      proxyRes.on('end', () => res.end());

    } else {
      // ── Regular JSON response ──────────────────────────────────────────────
      let responseBody = '';
      proxyRes.on('data', chunk => { responseBody += chunk; });
      proxyRes.on('end', () => {
        if (eventId) {
          try {
            const rpc = JSON.parse(responseBody);
            updateEventStatus(
              eventId,
              rpc.error ? 'error' : 'success',
              rpc.error?.message,
            );
          } catch {}
        }
        res.end(responseBody);
      });
    }
  });

  proxyReq.on('error', err => {
    process.stderr.write(`[http-proxy] Forward error: ${err.message}\n`);
    if (eventId) updateEventStatus(eventId, 'error', err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'Proxy forward failed', detail: err.message }));
    }
  });

  if (body) proxyReq.write(body);
  proxyReq.end();
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function startHttpProxy() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    // Health check
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, services: Object.keys(SERVICES), port: PROXY_PORT }));
      return;
    }

    // Route: /proxy/<service>
    const match = req.url.match(/^\/proxy\/([^/?]+)/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. Use /proxy/<service>' }));
      return;
    }

    const service = match[1];
    const config  = SERVICES[service];

    if (!config) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error:    `Unknown service: ${service}`,
        known:    Object.keys(SERVICES),
        hint:     'Add it to SERVICES in src/http-proxy.js',
      }));
      return;
    }

    // Collect request body
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      // Log tool calls before forwarding
      let eventId = null;
      try {
        const rpc = JSON.parse(body);
        if (rpc?.method === 'tools/call') {
          const event = {
            id:         newId(),
            timestamp:  new Date().toISOString(),
            source:     'http_proxy',
            agent_id:   'claude',
            mcp_name:   service,
            tool_name:  rpc.params?.name      || 'unknown',
            input:      rpc.params?.arguments || {},
            status:     'called',
            request_id: rpc.id ?? null,
          };
          appendEvent(event);
          eventId = event.id;
        }
      } catch {}

      forwardRequest(req, res, config.url, body, eventId);
    });
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`[http-proxy] Port ${PROXY_PORT} already in use — is another instance running?\n`);
    } else {
      process.stderr.write(`[http-proxy] Server error: ${err.message}\n`);
    }
  });

  server.listen(PROXY_PORT, '127.0.0.1', () => {
    process.stderr.write(`[http-proxy] Running on http://127.0.0.1:${PROXY_PORT}\n`);
    process.stderr.write(`[http-proxy] Services: ${Object.keys(SERVICES).join(', ')}\n`);
  });

  return server;
}

module.exports = { startHttpProxy };
