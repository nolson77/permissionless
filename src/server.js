const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');

const PORT = 3000;
const DATA_FILE = path.join(__dirname, '..', 'data.json');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

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

// ─── Claude Desktop config reader ─────────────────────────────────────────────
function getClaudeConfig() {
  const configPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return null;
  }
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
  const parsed = url.parse(req.url, true);
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

    if (!pathname.startsWith('/api/')) {
      res.writeHead(404); res.end('Not found'); return;
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
        const { agent_id } = parsed.query;
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

    // ── Claude config ─────────────────────────────────────────────────────────
    if (pathname === '/api/claude-config' && method === 'GET') {
      return json(res, 200, getClaudeConfig() || {});
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
