const fs = require('fs');
const os = require('os');
const path = require('path');

// Phase 1 brief specifies this file path.
const METADATA_PATH = path.join(os.homedir(), 'Developer', 'permissionless', 'credential-metadata.json');

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    if (!raw.trim()) return { credentials: [] };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { credentials: parsed };
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.credentials)) return parsed;
    return { credentials: [] };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { credentials: [] };
    throw err;
  }
}

async function writeJsonFileAtomic(filePath, obj) {
  await ensureDirExists(filePath);
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const json = JSON.stringify(obj, null, 2);
  await fs.promises.writeFile(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(tmpPath, filePath);
}

function normalizeEntry(account, fields) {
  const base = {
    account,
    mcp_assignment: [],
    date_added: today(),
    last_rotated: today(),
    last_used: null,
    source: 'keychain',
  };

  const merged = { ...base, ...(fields || {}) };

  if (!Array.isArray(merged.mcp_assignment)) {
    merged.mcp_assignment = merged.mcp_assignment ? [String(merged.mcp_assignment)] : [];
  }

  merged.account = String(merged.account);
  if (merged.last_used === undefined) merged.last_used = null;

  return merged;
}

async function loadAll() {
  const doc = await readJsonFile(METADATA_PATH);
  const creds = Array.isArray(doc.credentials) ? doc.credentials : [];
  return creds;
}

async function saveAll(credentials) {
  await writeJsonFileAtomic(METADATA_PATH, { credentials });
}

async function get(account) {
  if (!account || typeof account !== 'string') throw new Error('metadata.get: account is required');
  const credentials = await loadAll();
  return credentials.find((c) => c && c.account === account) || null;
}

async function set(account, fields) {
  if (!account || typeof account !== 'string') throw new Error('metadata.set: account is required');
  const credentials = await loadAll();
  const idx = credentials.findIndex((c) => c && c.account === account);

  if (idx >= 0) {
    credentials[idx] = normalizeEntry(account, { ...credentials[idx], ...(fields || {}) });
  } else {
    credentials.push(normalizeEntry(account, fields));
  }

  await saveAll(credentials);
  return await get(account);
}

async function remove(account) {
  if (!account || typeof account !== 'string') throw new Error('metadata.delete: account is required');
  const credentials = await loadAll();
  const next = credentials.filter((c) => c && c.account !== account);
  await saveAll(next);
}

async function list() {
  return await loadAll();
}

async function markRotated(account) {
  if (!account || typeof account !== 'string') throw new Error('metadata.markRotated: account is required');
  const existing = await get(account);
  if (!existing) {
    // If we rotate something not yet tracked, create a minimal entry.
    return await set(account, { last_rotated: today(), date_added: today(), source: 'keychain' });
  }
  return await set(account, { last_rotated: today() });
}

module.exports = {
  METADATA_PATH,
  get,
  set,
  delete: remove,
  list,
  markRotated,
};

