const { execFile } = require('child_process');

const SECURITY_BIN = '/usr/bin/security';
const SERVICE_NAME = 'permissionless';

function execSecurity(args) {
  return new Promise((resolve, reject) => {
    execFile(SECURITY_BIN, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Pass through exit code so callers can distinguish "not found" (44)
        err.exitCode = typeof err.code === 'number' ? err.code : err.code;
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

async function set(account, secret) {
  if (!account || typeof account !== 'string') {
    throw new Error('keychain.set: account is required');
  }
  if (typeof secret !== 'string') {
    throw new Error('keychain.set: secret must be a string');
  }

  // Never log the secret value
  await execSecurity(['add-generic-password', '-s', SERVICE_NAME, '-a', account, '-w', secret, '-U']);
}

async function get(account) {
  if (!account || typeof account !== 'string') {
    throw new Error('keychain.get: account is required');
  }

  try {
    const out = await execSecurity(['find-generic-password', '-s', SERVICE_NAME, '-a', account, '-w']);
    return out.trim();
  } catch (err) {
    // Exit code 44 = item not found
    const code = typeof err.code === 'number' ? err.code : err.exitCode;
    if (code === 44) {
      throw new Error(`No credential found for '${account}'. Run: permissionless add ${account}`);
    }
    throw err;
  }
}

async function remove(account) {
  if (!account || typeof account !== 'string') {
    throw new Error('keychain.delete: account is required');
  }

  try {
    await execSecurity(['delete-generic-password', '-s', SERVICE_NAME, '-a', account]);
  } catch (err) {
    // If it's already gone (44), treat as success
    const code = typeof err.code === 'number' ? err.code : err.exitCode;
    if (code === 44) return;
    throw err;
  }
}

async function list() {
  // We scan `security dump-keychain` output and extract all accounts whose
  // service (`svce`) is "permissionless". This avoids ever printing secrets.
  const out = await execSecurity(['dump-keychain']);
  const lines = out.split('\n');
  const accounts = new Set();

  let current = { svce: null, acct: null };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Records are separated by blank lines and "keychain: " headers.
    if (line.startsWith('keychain:')) {
      if (current.svce === SERVICE_NAME && current.acct) {
        accounts.add(current.acct);
      }
      current = { svce: null, acct: null };
      continue;
    }

    // Example lines we care about:
    // "0x00000007 <blob>=\"permissionless\""  (service)
    // "0x00000007 <blob>=\"NOTION_API_KEY\""  (account)
    const match = line.match(/<blob>="([^"]+)"/);
    if (!match) continue;
    const value = match[1];

    if (line.includes('"svce"')) {
      current.svce = value;
    } else if (line.includes('"acct"')) {
      current.acct = value;
    }
  }

  // Capture last record if needed
  if (current.svce === SERVICE_NAME && current.acct) {
    accounts.add(current.acct);
  }

  return Array.from(accounts).sort();
}

module.exports = {
  set,
  get,
  delete: remove,
  list,
};

