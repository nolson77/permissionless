const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const keychain = require('./keychain');
const metadata = require('./metadata');
const launcher = require('./launcher');
const configManager = require('./config-manager');

const PORT = 3000;
const DATA_FILE = path.join(__dirname, '..', 'data.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function rotationAgeDays(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function envHasPlaintextSecret(envObj) {
  if (!envObj || typeof envObj !== 'object') return false;
  return Object.values(envObj).some((v) => typeof v === 'string' && v.length > 0);
}

function getServerByName(claudeConfig, mcpName) {
  if (!claudeConfig || typeof claudeConfig !== 'object') return null;
  if (claudeConfig.mcpServers && Object.prototype.hasOwnProperty.call(claudeConfig.mcpServers, mcpName)) {
    return { enabled: true, server: claudeConfig.mcpServers[mcpName] };
  }
  if (claudeConfig.disabled_mcpServers && Object.prototype.hasOwnProperty.call(claudeConfig.disabled_mcpServers, mcpName)) {
    return { enabled: false, server: claudeConfig.disabled_mcpServers[mcpName] };
  }
  return null;
}

// ─── Seed data (Nick's real agents from Notion tracker) ───────────────────────
const DEFAULT_DATA = {
  agents: [
    { id: 'claude',         name: 'Claude',          provider: 'Anthropic', type: 'assistant', icon: '🧠', status: 'active',   created: '2026-03-08' },
    { id: 'chatgpt',        name: 'ChatGPT',         provider: 'OpenAI',    type: 'assistant', icon: '💬', status: 'active',   created: '2026-03-08' },
    { id: 'devin',          name: 'Devin',           provider: 'Cognition', type: 'engineer',  icon: '🔧', status: 'active',   created: '2026-03-08' },
    { id: 'github-copilot', name: 'GitHub Copilot',  provider: 'GitHub',    type: 'assistant', icon: '👩‍💻', status: 'active',   created: '2026-03-08' },
  ],
  permissions: [
    {
      id: 'p1', agent_id: 'claude',
      tool: 'Notion MCP', platform: 'Local', login_type: 'MCP Token',
      access_level: 'Editor',
      scopes: 'All tools except notion-update-page set to Always Allow',
      purpose: 'Allow Claude to build and modify Notion databases locally',
      risk_level: 'Low', status: 'Active',
      granted_date: '2026-03-08', last_verified: null,
      two_fa_enabled: false,
      notes: 'notion-update-page requires per-action approval'
    },
    {
      id: 'p2', agent_id: 'claude',
      tool: 'Linear MCP', platform: 'Local', login_type: 'MCP Token',
      access_level: 'Editor',
      scopes: 'Custom',
      purpose: 'Create and edit project plans in Linear',
      risk_level: 'Low', status: 'Active',
      granted_date: '2026-03-08', last_verified: null,
      two_fa_enabled: false, notes: ''
    },
    {
      id: 'p3', agent_id: 'claude',
      tool: 'GitHub MCP', platform: 'Local', login_type: 'MCP Token',
      access_level: 'Editor',
      scopes: '',
      purpose: 'Allow Claude to create repositories and commit scripts',
      risk_level: 'Medium', status: 'Active',
      granted_date: '2026-03-08', last_verified: null,
      two_fa_enabled: false,
      notes: 'Scopes not fully documented — review recommended'
    },
    {
      id: 'p4', agent_id: 'devin',
      tool: 'GitHub PAT', platform: 'Other', login_type: 'API Key',
      access_level: 'Editor',
      scopes: 'Contents: Read and Write',
      purpose: 'Allow Devin to commit code to repositories',
      risk_level: 'Medium', status: 'Inactive',
      granted_date: '2026-03-07', last_verified: null,
      two_fa_enabled: false, notes: 'Created for a specific task, now inactive'
    },
    {
      id: 'p5', agent_id: 'chatgpt',
      tool: 'Quickbooks (shared)', platform: 'Apple', login_type: 'Password',
      access_level: 'Admin',
      scopes: 'Full admin access',
      purpose: 'Financial information tracking and reporting',
      risk_level: 'High', status: 'Active',
      granted_date: null, last_verified: null,
      two_fa_enabled: true,
      notes: 'Shared password with colleague. 2FA goes to Nick\'s phone — colleague must text to log in. Password stored in both keychains.'
    },
    {
      id: 'p6', agent_id: 'chatgpt',
      tool: 'DocuSign (shared)', platform: 'Apple', login_type: 'Password',
      access_level: 'Admin',
      scopes: 'Full admin access',
      purpose: 'Legal contract signing',
      risk_level: 'Medium', status: 'Active',
      granted_date: null, last_verified: null,
      two_fa_enabled: false,
      notes: 'Shared password with colleague. Must notify each other of password changes. No 2FA — consider enabling.'
    },
  ]
};

// ─── Data helpers ──────────────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return DEFAULT_DATA;
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── Claude Desktop config reader / writer ────────────────────────────────────
const CLAUDE_CONFIG_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const MCP_TOOLS_FILE = path.join(__dirname, '..', 'mcp_tools.json');
const ACTIVITY_LOG   = path.join(__dirname, '..', 'activity_log.json');

function getMcpTools() {
  try { return JSON.parse(fs.readFileSync(MCP_TOOLS_FILE, 'utf8')); } catch { return {}; }
}
function saveMcpTools(data) {
  fs.writeFileSync(MCP_TOOLS_FILE, JSON.stringify(data, null, 2));
}

function loadActivityLog() {
  try { return JSON.parse(fs.readFileSync(ACTIVITY_LOG, 'utf8')); }
  catch { return { events: [] }; }
}

function appendActivityEvent(event) {
  const log = loadActivityLog();
  log.events.unshift(event);
  if (log.events.length > 2000) log.events = log.events.slice(0, 2000);
  fs.writeFileSync(ACTIVITY_LOG, JSON.stringify(log, null, 2));
}

function getClaudeConfig() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_CONFIG_PATH, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveClaudeConfig(config) {
  fs.writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── Body parser ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// ─── Route handlers ───────────────────────────────────────────────────────────
function json(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = parsed;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  try {
    // ── Static files ──────────────────────────────────────────────────────────
    if (pathname === '/' || pathname === '/index.html') {
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
      return;
    }

    if (pathname === '/credentials' || pathname === '/credentials.html') {
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'credentials.html')));
      return;
    }

    if (!pathname.startsWith('/api/')) {
      res.writeHead(404); res.end('Not found'); return;
    }

    // ── Credential manager (Phase 1) ─────────────────────────────────────────
    if (pathname === '/api/credentials' && method === 'GET') {
      const [metaList, accounts, claudeCfg] = await Promise.all([
        metadata.list(),
        keychain.list().catch(() => []),
        configManager.read().catch(() => ({})),
      ]);
      const inKeychain = new Set(accounts);

      const result = (metaList || []).map((m) => {
        const account = m?.account;
        const assignments = Array.isArray(m?.mcp_assignment) ? m.mcp_assignment : [];

        let plaintextInConfig = false;
        let usingLauncher = false;
        for (const mcpName of assignments) {
          const found = getServerByName(claudeCfg, mcpName);
          if (!found) continue;
          if (configManager.isLauncherServer(found.server)) usingLauncher = true;
          if (envHasPlaintextSecret(found.server?.env) && found.server?.env?.[account]) plaintextInConfig = true;
        }

        const lastRotated = m?.last_rotated || null;
        const ageDays = rotationAgeDays(lastRotated);
        return {
          account,
          mcp_assignment: assignments,
          date_added: m?.date_added || null,
          last_rotated: lastRotated,
          last_used: m?.last_used ?? null,
          source: m?.source || 'keychain',
          rotation_age_days: ageDays,
          in_keychain: account ? inKeychain.has(account) : false,
          plaintext_in_config: plaintextInConfig,
          using_launcher: usingLauncher,
        };
      });

      return json(res, 200, result);
    }

    if (pathname === '/api/credentials' && method === 'POST') {
      const body = await readBody(req);
      const account = String(body.account || '').trim();
      const secret = typeof body.secret === 'string' ? body.secret : '';
      const mcp_assignment = Array.isArray(body.mcp_assignment)
        ? body.mcp_assignment.map(String)
        : (typeof body.mcp_assignment === 'string' && body.mcp_assignment.trim())
          ? body.mcp_assignment.split(',').map((s) => s.trim()).filter(Boolean)
          : [];

      if (!account) return json(res, 400, { error: 'account required' });
      if (!secret) return json(res, 400, { error: 'secret required' });

      await keychain.set(account, secret);
      await metadata.set(account, {
        account,
        mcp_assignment,
        date_added: today(),
        last_rotated: today(),
        source: 'keychain',
      });
      return json(res, 201, { ok: true });
    }

    if (pathname === '/api/credentials/rotate' && method === 'POST') {
      const body = await readBody(req);
      const account = String(body.account || '').trim();
      const newSecret = typeof body.secret === 'string' ? body.secret : (typeof body.new_secret === 'string' ? body.new_secret : '');
      if (!account) return json(res, 400, { error: 'account required' });
      if (!newSecret) return json(res, 400, { error: 'new secret required' });

      await keychain.set(account, newSecret);
      await metadata.markRotated(account);
      return json(res, 200, { ok: true });
    }

    const credDeleteMatch = pathname.match(/^\/api\/credentials\/([^/]+)$/);
    if (credDeleteMatch && method === 'DELETE') {
      const account = decodeURIComponent(credDeleteMatch[1]);
      await keychain.delete(account);
      await metadata.delete(account);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/inject' && method === 'POST') {
      const metaList = await metadata.list();
      const claudeCfg = await configManager.read();
      const servers = claudeCfg.mcpServers || {};
      const disabled = claudeCfg.disabled_mcpServers || {};

      const lookup = (name) => {
        if (Object.prototype.hasOwnProperty.call(servers, name)) return servers[name];
        if (Object.prototype.hasOwnProperty.call(disabled, name)) return disabled[name];
        return null;
      };

      let injected = 0;
      for (const entry of metaList || []) {
        const account = entry?.account;
        const assignments = Array.isArray(entry?.mcp_assignment) ? entry.mcp_assignment : [];
        if (!account || assignments.length === 0) continue;

        for (const mcpName of assignments) {
          const server = lookup(mcpName);
          if (!server?.command) continue;
          const args = Array.isArray(server.args) ? server.args : [];

          const script = launcher.generate({
            envVarName: account,
            keychainAccount: account,
            mcpCommand: server.command,
            mcpArgs: args,
          });

          await configManager.injectLauncher(mcpName, ['-e', script]);
          injected += 1;
        }
      }

      return json(res, 200, { ok: true, injected });
    }

    // ── Dashboard ─────────────────────────────────────────────────────────────
    if (pathname === '/api/dashboard' && method === 'GET') {
      const data = loadData();
      const active = data.permissions.filter(p => p.status === 'Active');
      const highRisk = active.filter(p => p.risk_level === 'High');
      const noScopes = active.filter(p => !p.scopes || p.scopes.trim() === '');
      const neverVerified = active.filter(p => !p.last_verified);

      const attention = [
        ...highRisk.map(p => ({ id: p.id, agent_id: p.agent_id, type: 'high_risk',     icon: '🔴', message: `${p.tool} has High risk access`, sub: 'Review and confirm this is still needed' })),
        ...noScopes.map(p => ({ id: p.id, agent_id: p.agent_id, type: 'no_scopes',      icon: '🟡', message: `${p.tool} has undocumented scopes`, sub: 'Document exactly what this agent can access' })),
      ].slice(0, 5);

      return json(res, 200, {
        totalAgents: data.agents.length,
        activePermissions: active.length,
        highRiskCount: highRisk.length,
        neverVerifiedCount: neverVerified.length,
        attention
      });
    }

    // ── Agents ────────────────────────────────────────────────────────────────
    if (pathname === '/api/agents') {
      const data = loadData();
      if (method === 'GET') {
        const agents = data.agents.map(a => ({
          ...a,
          permissionCount: data.permissions.filter(p => p.agent_id === a.id).length,
          activeCount:     data.permissions.filter(p => p.agent_id === a.id && p.status === 'Active').length,
          highRiskCount:   data.permissions.filter(p => p.agent_id === a.id && p.risk_level === 'High' && p.status === 'Active').length,
          mediumRiskCount: data.permissions.filter(p => p.agent_id === a.id && p.risk_level === 'Medium' && p.status === 'Active').length,
        }));
        return json(res, 200, agents);
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const agent = { ...body, id: body.name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now(), created: new Date().toISOString().split('T')[0] };
        data.agents.push(agent);
        saveData(data);
        return json(res, 201, agent);
      }
    }

    const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch) {
      const data = loadData();
      const id = agentMatch[1];
      if (method === 'DELETE') {
        data.agents = data.agents.filter(a => a.id !== id);
        data.permissions = data.permissions.filter(p => p.agent_id !== id);
        saveData(data);
        return json(res, 200, {});
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const idx = data.agents.findIndex(a => a.id === id);
        if (idx < 0) return json(res, 404, {});
        data.agents[idx] = { ...data.agents[idx], ...body };
        saveData(data);
        return json(res, 200, data.agents[idx]);
      }
    }

    // ── Permissions ───────────────────────────────────────────────────────────
    if (pathname === '/api/permissions') {
      const data = loadData();
      if (method === 'GET') {
        const agent_id = parsed.searchParams.get('agent_id');
        const perms = agent_id ? data.permissions.filter(p => p.agent_id === agent_id) : data.permissions;
        return json(res, 200, perms);
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const perm = { ...body, id: 'p' + Date.now() };
        data.permissions.push(perm);
        saveData(data);
        return json(res, 201, perm);
      }
    }

    const permMatch = pathname.match(/^\/api\/permissions\/([^/]+)$/);
    if (permMatch) {
      const data = loadData();
      const id = permMatch[1];
      if (method === 'PUT') {
        const body = await readBody(req);
        const idx = data.permissions.findIndex(p => p.id === id);
        if (idx < 0) return json(res, 404, {});
        data.permissions[idx] = { ...data.permissions[idx], ...body };
        saveData(data);
        return json(res, 200, data.permissions[idx]);
      }
      if (method === 'DELETE') {
        data.permissions = data.permissions.filter(p => p.id !== id);
        saveData(data);
        return json(res, 200, {});
      }
    }

    // ── Claude config (raw) ───────────────────────────────────────────────────
    if (pathname === '/api/claude-config' && method === 'GET') {
      return json(res, 200, getClaudeConfig() || {});
    }

    // ── MCP Manager ───────────────────────────────────────────────────────────

    // GET /api/mcp — list all MCPs (active + disabled)
    if (pathname === '/api/mcp' && method === 'GET') {
      const config = getClaudeConfig() || {};
      const active   = config.mcpServers          || {};
      const disabled = config.disabled_mcpServers || {};
      const result = [
        ...Object.entries(active).map(([name, cfg])   => ({ name, enabled: true,  config: cfg })),
        ...Object.entries(disabled).map(([name, cfg]) => ({ name, enabled: false, config: cfg })),
      ];
      return json(res, 200, result);
    }

    // POST /api/mcp — add a new MCP to active mcpServers
    if (pathname === '/api/mcp' && method === 'POST') {
      const body = await readBody(req);
      if (!body.name || !body.config) return json(res, 400, { error: 'name and config required' });
      const config = getClaudeConfig() || {};
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers[body.name] = body.config;
      saveClaudeConfig(config);
      return json(res, 201, { name: body.name, enabled: true, config: body.config });
    }

    // PUT /api/mcp/:name/toggle — enable ↔ disable an MCP
    const mcpToggleMatch = pathname.match(/^\/api\/mcp\/([^/]+)\/toggle$/);
    if (mcpToggleMatch && method === 'PUT') {
      const name = decodeURIComponent(mcpToggleMatch[1]);
      const config = getClaudeConfig() || {};
      if (!config.mcpServers)          config.mcpServers          = {};
      if (!config.disabled_mcpServers) config.disabled_mcpServers = {};

      if (config.mcpServers[name] !== undefined) {
        // Currently active → disable
        config.disabled_mcpServers[name] = config.mcpServers[name];
        delete config.mcpServers[name];
        saveClaudeConfig(config);
        return json(res, 200, { name, enabled: false });
      } else if (config.disabled_mcpServers[name] !== undefined) {
        // Currently disabled → enable
        config.mcpServers[name] = config.disabled_mcpServers[name];
        delete config.disabled_mcpServers[name];
        saveClaudeConfig(config);
        return json(res, 200, { name, enabled: true });
      }
      return json(res, 404, { error: 'MCP not found' });
    }

    // PUT /api/mcp/:name — update an MCP's config (env vars, args, etc.)
    // DELETE /api/mcp/:name — remove an MCP entirely
    const mcpNameMatch = pathname.match(/^\/api\/mcp\/([^/]+)$/);
    if (mcpNameMatch && method === 'PUT') {
      const name = decodeURIComponent(mcpNameMatch[1]);
      const body = await readBody(req);
      const config = getClaudeConfig() || {};
      const bucket = config.mcpServers?.[name] !== undefined ? 'mcpServers' : 'disabled_mcpServers';
      if (!config[bucket]?.[name]) return json(res, 404, { error: 'MCP not found' });
      config[bucket][name] = { ...config[bucket][name], ...body.config };
      saveClaudeConfig(config);
      return json(res, 200, { name, enabled: bucket === 'mcpServers', config: config[bucket][name] });
    }
    if (mcpNameMatch && method === 'DELETE') {
      const name = decodeURIComponent(mcpNameMatch[1]);
      const config = getClaudeConfig() || {};
      delete (config.mcpServers          || {})[name];
      delete (config.disabled_mcpServers || {})[name];
      saveClaudeConfig(config);
      return json(res, 200, {});
    }

    // ── Tool permissions: GET /api/mcp/:name/tools ─────────────────────────────
    const mcpToolsMatch = pathname.match(/^\/api\/mcp\/([^/]+)\/tools$/);
    if (mcpToolsMatch && method === 'GET') {
      const name = decodeURIComponent(mcpToolsMatch[1]);
      const tools = getMcpTools();
      return json(res, 200, tools[name] || []);
    }

    // PUT /api/mcp/:name/tools — bulk replace tool list
    if (mcpToolsMatch && method === 'PUT') {
      const name = decodeURIComponent(mcpToolsMatch[1]);
      const body = await readBody(req);
      const tools = getMcpTools();
      tools[name] = body.tools || [];
      saveMcpTools(tools);
      return json(res, 200, tools[name]);
    }

    // ── Single tool permission: PUT /api/mcp/:name/tools/:toolName ─────────────
    const mcpToolItemMatch = pathname.match(/^\/api\/mcp\/([^/]+)\/tools\/([^/]+)$/);
    if (mcpToolItemMatch && method === 'PUT') {
      const name     = decodeURIComponent(mcpToolItemMatch[1]);
      const toolName = decodeURIComponent(mcpToolItemMatch[2]);
      const body     = await readBody(req);
      const tools    = getMcpTools();
      if (!tools[name]) tools[name] = [];
      const idx = tools[name].findIndex(t => t.name === toolName);
      if (idx >= 0) {
        tools[name][idx].permission = body.permission;
      } else {
        tools[name].push({ name: toolName, label: toolName, permission: body.permission });
      }
      saveMcpTools(tools);
      return json(res, 200, tools[name].find(t => t.name === toolName));
    }

    // ── Activity log ──────────────────────────────────────────────────────────

    // GET /api/activity — list events (filterable by agent_id, mcp, limit)
    if (pathname === '/api/activity' && method === 'GET') {
      const log     = loadActivityLog();
      const agentId = parsed.searchParams.get('agent_id');
      const mcpName = parsed.searchParams.get('mcp');
      const limit   = Math.min(parseInt(parsed.searchParams.get('limit') || '500', 10), 2000);
      let events    = log.events || [];
      if (agentId) events = events.filter(e => e.agent_id === agentId);
      if (mcpName) events = events.filter(e => e.mcp_name === mcpName);
      return json(res, 200, events.slice(0, limit));
    }

    // POST /api/activity — manually append an event (used by proxy adapter)
    if (pathname === '/api/activity' && method === 'POST') {
      const body  = await readBody(req);
      const event = {
        id:        'evt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        source:    body.source    || 'manual',
        agent_id:  body.agent_id  || 'unknown',
        mcp_name:  body.mcp_name  || 'unknown',
        tool_name: body.tool_name || 'unknown',
        input:     body.input     || {},
        status:    body.status    || 'called',
      };
      appendActivityEvent(event);
      return json(res, 201, event);
    }

    // GET /api/activity/stats — summary counts for the dashboard
    if (pathname === '/api/activity/stats' && method === 'GET') {
      const log    = loadActivityLog();
      const events = log.events || [];
      const today  = new Date().toISOString().split('T')[0];
      const stats  = {
        total:   events.length,
        today:   events.filter(e => e.timestamp?.startsWith(today)).length,
        byAgent: {},
        byMcp:   {},
      };
      events.forEach(e => {
        stats.byAgent[e.agent_id] = (stats.byAgent[e.agent_id] || 0) + 1;
        stats.byMcp[e.mcp_name]   = (stats.byMcp[e.mcp_name]   || 0) + 1;
      });
      return json(res, 200, stats);
    }

    json(res, 404, { error: 'Not found' });

  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  ┌────────────────────────────────────────┐
  │                                        │
  │   🔐  permissionless  is running       │
  │                                        │
  │   Open  http://localhost:${PORT}         │
  │                                        │
  └────────────────────────────────────────┘
  `);
});
