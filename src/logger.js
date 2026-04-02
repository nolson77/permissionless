// ─────────────────────────────────────────────────────────────────────────────
// src/logger.js — Permissionless MCP Logger
//
// A zero-dependency stdio passthrough proxy that sits between Claude Desktop
// and any MCP server, logging every tool call to activity_log.json.
//
// ── SETUP ─────────────────────────────────────────────────────────────────────
// In claude_desktop_config.json, wrap any MCP entry with the logger.
// Replace a direct MCP entry like:
//
//   "notion": {
//     "command": "npx",
//     "args": ["-y", "@modelcontextprotocol/server-notion"],
//     "env": { "NOTION_API_KEY": "sk-..." }
//   }
//
// With:
//
//   "notion": {
//     "command": "node",
//     "args": [
//       "/Users/nickolson/Documents/Python/permissionless/src/logger.js",
//       "notion",
//       "npx", "-y", "@modelcontextprotocol/server-notion"
//     ],
//     "env": { "NOTION_API_KEY": "sk-..." }
//   }
//
// The logger receives the same env vars (API keys etc.) and passes them through
// to the downstream MCP via process.env — no changes needed there.
//
// Restart Claude Desktop after editing the config.
//
// ── HOW IT WORKS ──────────────────────────────────────────────────────────────
// Claude Desktop ──stdin──► Logger ──stdin──► Real MCP server
//                ◄─stdout──        ◄─stdout──
//
// The logger intercepts JSON-RPC 2.0 messages on stdin, looking for
// "tools/call" requests. When found, it writes an event to activity_log.json,
// then forwards the message to the downstream MCP unchanged. When the response
// comes back, it updates the event status to "success" or "error".
//
// ── CROSS-AGENT PROXY (future) ─────────────────────────────────────────────
// Also starts an HTTP server on port 3001. This is the foundation for
// supporting non-Claude agents (ChatGPT, Cursor, Devin, etc.).
//
// Architecture:
//   1. Register each agent in data.json with a proxy API key
//      { "key": "pk-xxx", "agent_id": "chatgpt", "service": "notion" }
//   2. Give the agent your proxy key instead of the real service key
//   3. Agent calls: POST http://localhost:3001/proxy/<service>/<tool>
//                   Authorization: Bearer pk-xxx
//                   Body: { "input": { ...args } }
//   4. Logger validates the key → identifies agent_id → logs → forwards to
//      the real service API with the real key → returns the result
//
// Every agent, every protocol, one unified activity timeline.
// The proxy key registry lives in data.json; real keys never leave the machine.
// The /proxy/:service/:tool endpoint returns 501 until the adapter is built.
// ─────────────────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');

const MCP_NAME        = process.argv[2] || 'unknown';
const DOWNSTREAM_CMD  = process.argv[3];
const DOWNSTREAM_ARGS = process.argv.slice(4);

const BASE_DIR     = path.join(__dirname, '..');
const ACTIVITY_LOG = path.join(BASE_DIR, 'activity_log.json');
const PROXY_PORT   = 3001;

// ─── Activity log helpers ─────────────────────────────────────────────────────

function loadLog() {
  try { return JSON.parse(fs.readFileSync(ACTIVITY_LOG, 'utf8')); }
  catch { return { events: [] }; }
}

function appendEvent(event) {
  const log = loadLog();
  log.events.unshift(event);                                   // newest first
  if (log.events.length > 2000) log.events = log.events.slice(0, 2000);
  try { fs.writeFileSync(ACTIVITY_LOG, JSON.stringify(log, null, 2)); }
  catch (e) { process.stderr.write(`[logger] Write error: ${e.message}\n`); }
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

// ─── MCP stdio proxy ──────────────────────────────────────────────────────────

function startStdioProxy() {
  if (!DOWNSTREAM_CMD) {
    process.stderr.write('[logger] No downstream command — running in HTTP-only mode\n');
    return;
  }

  const downstream = spawn(DOWNSTREAM_CMD, DOWNSTREAM_ARGS, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env:   process.env,                    // pass API keys etc. straight through
  });

  // Maps in-flight JSON-RPC request IDs → event IDs
  // so we can update status to "success" or "error" when the response arrives
  const pendingCalls = new Map();

  // ── stdin (from Claude Desktop) → downstream ──────────────────────────────
  let inBuf = '';
  process.stdin.on('data', chunk => {
    inBuf += chunk.toString();
    const lines = inBuf.split('\n');
    inBuf = lines.pop();                   // hold incomplete trailing line

    for (const line of lines) {
      if (!line.trim()) { downstream.stdin.write('\n'); continue; }

      try {
        const rpc = JSON.parse(line);

        // Intercept tool calls — log them before forwarding
        if (rpc.method === 'tools/call') {
          const event = {
            id:         newId(),
            timestamp:  new Date().toISOString(),
            source:     'mcp_proxy',
            agent_id:   'claude',
            mcp_name:   MCP_NAME,
            tool_name:  rpc.params?.name        || 'unknown',
            input:      rpc.params?.arguments   || {},
            status:     'called',
            request_id: rpc.id ?? null,
          };
          appendEvent(event);
          if (rpc.id != null) pendingCalls.set(String(rpc.id), event.id);
        }
      } catch {}

      downstream.stdin.write(line + '\n');
    }
  });

  process.stdin.on('end', () => downstream.stdin.end());

  // ── downstream stdout → stdout (to Claude Desktop) ────────────────────────
  let outBuf = '';
  downstream.stdout.on('data', chunk => {
    outBuf += chunk.toString();
    const lines = outBuf.split('\n');
    outBuf = lines.pop();

    for (const line of lines) {
      if (!line.trim()) { process.stdout.write('\n'); continue; }

      // Update event status when a response comes back
      try {
        const rpc = JSON.parse(line);
        const key = String(rpc.id);
        if (rpc.id != null && pendingCalls.has(key)) {
          const evtId = pendingCalls.get(key);
          pendingCalls.delete(key);
          updateEventStatus(evtId, rpc.error ? 'error' : 'success', rpc.error?.message);
        }
      } catch {}

      process.stdout.write(line + '\n');
    }
  });

  downstream.on('exit',  code => process.exit(code ?? 0));
  downstream.on('error', err  => {
    process.stderr.write(`[logger] Downstream error: ${err.message}\n`);
    process.exit(1);
  });
}

// ─── API Proxy HTTP server ────────────────────────────────────────────────────
// Runs on port 3001. Two purposes:
//   1. Receives external log events (POST /api/activity) from any source
//   2. Will serve as the cross-agent proxy endpoint (POST /proxy/:service/:tool)
//      once the adapter is implemented

function startProxyServer() {
  const srv = http.createServer((req, res) => {
    const send = (status, body) => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const url = new URL(req.url, `http://127.0.0.1:${PROXY_PORT}`);

    // Health check
    if (url.pathname === '/health' && req.method === 'GET') {
      return send(200, {
        ok:      true,
        mcp:     MCP_NAME,
        mode:    DOWNSTREAM_CMD ? 'stdio_proxy' : 'http_only',
        version: '0.1.0',
      });
    }

    // External event ingest — any agent or adapter can POST a log event here
    if (url.pathname === '/api/activity' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const evt = JSON.parse(body);
          appendEvent({
            id:        newId(),
            timestamp: new Date().toISOString(),
            source:    evt.source    || 'api_proxy',
            agent_id:  evt.agent_id  || 'unknown',
            mcp_name:  evt.mcp_name  || evt.service || 'unknown',
            tool_name: evt.tool_name || 'unknown',
            input:     evt.input     || {},
            status:    evt.status    || 'called',
          });
          send(201, { ok: true });
        } catch {
          send(400, { error: 'Invalid JSON' });
        }
      });
      return;
    }

    // ── FUTURE: POST /proxy/:service/:tool ─────────────────────────────────
    // Cross-agent proxy endpoint. When implemented, this will:
    //   1. Validate the Authorization: Bearer <proxy-key> header
    //   2. Look up the proxy key in data.json to find agent_id + real API key
    //   3. Log the call with the correct agent_id
    //   4. Forward the tool call to the real service API
    //   5. Return the result
    const proxyMatch = url.pathname.match(/^\/proxy\/([^/]+)\/([^/]+)$/);
    if (proxyMatch && req.method === 'POST') {
      const [, service, tool] = proxyMatch;
      return send(501, {
        error:   'API proxy adapter not yet implemented',
        service,
        tool,
        hint:    'See src/logger.js for the cross-agent architecture spec',
      });
    }

    send(404, { error: 'Not found' });
  });

  srv.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`[logger] Port ${PROXY_PORT} in use — proxy server skipped\n`);
    }
  });

  srv.listen(PROXY_PORT, '127.0.0.1', () => {
    process.stderr.write(`[logger] Proxy server on port ${PROXY_PORT} (${MCP_NAME})\n`);
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
startStdioProxy();
// startProxyServer(); // disabled until cross-agent proxy is implemented
