const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PATH = '/usr/local/bin/node';
const CONFIG_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude_desktop_config.json',
);

const BACKUP_DIR = path.join(os.homedir(), 'Developer', 'permissionless', 'config-backups');

function nowStamp() {
  // 2026-03-16T12-34-56
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '');
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function redactEnvSecrets(configObj) {
  const obj = deepClone(configObj || {});
  const redactBucket = (bucket) => {
    if (!bucket || typeof bucket !== 'object') return;
    for (const serverName of Object.keys(bucket)) {
      const server = bucket[serverName];
      if (!server || typeof server !== 'object') continue;
      if (server.env && typeof server.env === 'object') {
        const nextEnv = {};
        for (const [k, v] of Object.entries(server.env)) {
          if (typeof v === 'string' && v.length) nextEnv[k] = '<redacted>';
          else nextEnv[k] = v;
        }
        server.env = nextEnv;
      }
    }
  };

  redactBucket(obj.mcpServers);
  redactBucket(obj.disabled_mcpServers);
  return obj;
}

async function readRaw() {
  try {
    return await fs.promises.readFile(CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function read() {
  const raw = await readRaw();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function backup() {
  const obj = await read();
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  const backupPath = path.join(BACKUP_DIR, `claude_desktop_config.${nowStamp()}.json`);
  const redacted = redactEnvSecrets(obj);
  const text = JSON.stringify(redacted, null, 2);
  // Validate before write
  JSON.parse(text);
  await fs.promises.writeFile(backupPath, text, { encoding: 'utf8', mode: 0o600 });
  return backupPath;
}

async function write(obj) {
  // Always backup first (redacted).
  await backup();

  const text = JSON.stringify(obj, null, 2);
  // Never write invalid JSON
  JSON.parse(text);

  await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.promises.writeFile(CONFIG_PATH, text, { encoding: 'utf8', mode: 0o600 });
}

function isLauncherServer(server) {
  if (!server || typeof server !== 'object') return false;
  if (server.command !== NODE_PATH) return false;
  if (!Array.isArray(server.args)) return false;
  return server.args[0] === '-e' && typeof server.args[1] === 'string' && server.args[1].length > 0;
}

async function injectLauncher(mcpName, launcherArgs) {
  if (!mcpName || typeof mcpName !== 'string') {
    throw new Error('config.injectLauncher: mcpName is required');
  }
  if (!Array.isArray(launcherArgs) || launcherArgs.length < 2 || launcherArgs[0] !== '-e') {
    throw new Error("config.injectLauncher: launcherArgs must look like ['-e', '<script>']");
  }

  const config = await read();
  const buckets = ['mcpServers', 'disabled_mcpServers'];
  let bucketName = null;
  for (const b of buckets) {
    if (config[b] && Object.prototype.hasOwnProperty.call(config[b], mcpName)) {
      bucketName = b;
      break;
    }
  }
  if (!bucketName) {
    throw new Error(`config.injectLauncher: MCP '${mcpName}' not found in config`);
  }

  const existing = config[bucketName][mcpName] || {};
  config[bucketName][mcpName] = {
    ...existing,
    command: NODE_PATH,
    args: launcherArgs,
    env: {},
  };

  await write(config);
}

async function stripLaunchers() {
  // This intentionally re-introduces plaintext secrets into Claude config, which
  // is dangerous. Keep it gated behind an explicit opt-in.
  if (process.env.PERMISSIONLESS_ALLOW_PLAINTEXT !== '1') {
    throw new Error(
      "config.stripLaunchers is disabled by default. Set PERMISSIONLESS_ALLOW_PLAINTEXT=1 if you really want to write plaintext secrets into Claude's config.",
    );
  }

  const keychain = require('./keychain');
  const metadata = require('./metadata');

  const entries = await metadata.list();
  const config = await read();
  if (!config.mcpServers) config.mcpServers = {};

  for (const entry of entries) {
    const account = entry?.account;
    const assignments = Array.isArray(entry?.mcp_assignment) ? entry.mcp_assignment : [];
    if (!account || !assignments.length) continue;

    let secret;
    try {
      secret = await keychain.get(account);
    } catch {
      continue;
    }

    for (const mcpName of assignments) {
      const server = config.mcpServers?.[mcpName];
      if (!server || !isLauncherServer(server)) continue;
      const nextEnv = { ...(server.env || {}) };
      nextEnv[account] = secret;
      config.mcpServers[mcpName] = { ...server, env: nextEnv };
    }
  }

  await write(config);
}

module.exports = {
  CONFIG_PATH,
  NODE_PATH,
  read,
  write,
  injectLauncher,
  stripLaunchers,
  backup,
  isLauncherServer,
};

