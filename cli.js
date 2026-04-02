#!/usr/bin/env node
/* eslint-disable no-console */

const readline = require('readline');

const keychain = require('./src/keychain');
const metadata = require('./src/metadata');
const launcher = require('./src/launcher');
const config = require('./src/config-manager');

function usage() {
  return `
permissionless <command> [args]

Commands:
  permissionless add <account> [secret]
  permissionless remove <account>
  permissionless rotate <account> [new-secret]
  permissionless list
  permissionless inject
  permissionless status
`.trim();
}

function die(msg, code = 1) {
  if (msg) console.error(msg);
  process.exit(code);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const ms = now.getTime() - d.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function padRight(s, n) {
  const str = String(s ?? '');
  if (str.length >= n) return str;
  return str + ' '.repeat(n - str.length);
}

function isPlaintextEnvServer(server) {
  const env = server?.env;
  if (!env || typeof env !== 'object') return false;
  return Object.values(env).some((v) => typeof v === 'string' && v.length > 0);
}

function stty(args) {
  // Use full path; ignore if not available (e.g., non-tty).
  try {
    const { execFileSync } = require('child_process');
    execFileSync('/bin/stty', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function promptHidden(promptText) {
  if (!process.stdin.isTTY) {
    // Fallback: visible input (better than failing).
    return await promptVisible(promptText);
  }

  process.stdout.write(promptText);
  stty(['-echo']);

  return await new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      // Enter ends input. Allow paste.
      if (s.includes('\n') || s.includes('\r')) {
        process.stdin.off('data', onData);
        stty(['echo']);
        process.stdout.write('\n');
        resolve(buf.trimEnd());
        return;
      }
      buf += s;
    };
    process.stdin.on('data', onData);
  });
}

async function promptVisible(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(String(answer || ''));
    });
  });
}

async function cmdAdd(account, secretArg) {
  if (!account) die('Usage: permissionless add <account> [secret]');
  let secret = secretArg;

  if (secret) {
    console.warn('Warning: passing secrets on the command line may leak to shell history.');
    console.warn('Tip: omit the secret to be prompted securely.');
  } else {
    secret = await promptHidden(`Enter secret for ${account}: `);
  }

  if (!secret) die('Secret is required.');

  await keychain.set(account, secret);
  await metadata.set(account, {
    account,
    date_added: today(),
    last_rotated: today(),
    source: 'keychain',
  });

  console.log(`✓ ${account} stored in Keychain`);
}

async function cmdRemove(account) {
  if (!account) die('Usage: permissionless remove <account>');
  await keychain.delete(account);
  await metadata.delete(account);
  console.log(`✓ ${account} removed`);
}

async function cmdRotate(account, secretArg) {
  if (!account) die('Usage: permissionless rotate <account> [new-secret]');
  let secret = secretArg;
  if (secret) {
    console.warn('Warning: passing secrets on the command line may leak to shell history.');
    console.warn('Tip: omit the secret to be prompted securely.');
  } else {
    secret = await promptHidden(`Enter new secret for ${account}: `);
  }
  if (!secret) die('New secret is required.');

  await keychain.set(account, secret);
  await metadata.markRotated(account);
  console.log(`✓ ${account} rotated. Update any services that use this key.`);
}

async function cmdList() {
  const meta = await metadata.list();
  const accountsInKeychain = new Set(await keychain.list());
  const rows = meta
    .slice()
    .sort((a, b) => String(a.account).localeCompare(String(b.account)))
    .map((m) => {
      const acct = m.account;
      const mcp = Array.isArray(m.mcp_assignment) ? m.mcp_assignment.join(',') : '';
      const added = m.date_added || '';
      const rotated = m.last_rotated || '';
      const age = daysBetween(rotated);
      const present = accountsInKeychain.has(acct) ? 'yes' : 'no';
      return { acct, mcp, added, rotated, age: age == null ? '' : String(age), present };
    });

  const header = ['account', 'mcp', 'date added', 'last rotated', 'age(days)', 'in_keychain'];
  const widths = [30, 20, 12, 12, 9, 10];
  console.log(
    header.map((h, i) => padRight(h, widths[i])).join('  '),
  );
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    console.log(
      [
        padRight(r.acct, widths[0]),
        padRight(r.mcp, widths[1]),
        padRight(r.added, widths[2]),
        padRight(r.rotated, widths[3]),
        padRight(r.age, widths[4]),
        padRight(r.present, widths[5]),
      ].join('  '),
    );
  }
}

async function cmdInject() {
  const meta = await metadata.list();
  const claudeConfig = await config.read();
  const servers = claudeConfig.mcpServers || {};
  const disabled = claudeConfig.disabled_mcpServers || {};

  // Create a lookup for both enabled/disabled entries (we inject into whichever exists)
  const lookup = (name) => {
    if (Object.prototype.hasOwnProperty.call(servers, name)) return { bucket: 'mcpServers', server: servers[name] };
    if (Object.prototype.hasOwnProperty.call(disabled, name)) return { bucket: 'disabled_mcpServers', server: disabled[name] };
    return null;
  };

  let injected = 0;
  for (const entry of meta) {
    const account = entry?.account;
    const assignments = Array.isArray(entry?.mcp_assignment) ? entry.mcp_assignment : [];
    if (!account || assignments.length === 0) continue;

    for (const mcpName of assignments) {
      const found = lookup(mcpName);
      if (!found) continue;

      const origCmd = found.server?.command;
      const origArgs = Array.isArray(found.server?.args) ? found.server.args : [];
      if (!origCmd) continue;

      const script = launcher.generate({
        envVarName: account,
        keychainAccount: account,
        mcpCommand: origCmd,
        mcpArgs: origArgs,
      });

      await config.injectLauncher(mcpName, ['-e', script]);
      injected += 1;
    }
  }

  console.log('✓ Config updated. Restart Claude Desktop to apply.');
  if (injected === 0) {
    console.log('(No MCP entries were injected. Ensure metadata has mcp_assignment set for each account.)');
  }
}

async function cmdStatus() {
  const claudeConfig = await config.read();
  const servers = claudeConfig.mcpServers || {};
  const disabled = claudeConfig.disabled_mcpServers || {};

  const all = [
    ...Object.entries(servers).map(([name, cfg]) => ({ name, enabled: true, cfg })),
    ...Object.entries(disabled).map(([name, cfg]) => ({ name, enabled: false, cfg })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const header = ['mcp', 'enabled', 'mode', 'warnings'];
  const widths = [24, 7, 12, 40];
  console.log(header.map((h, i) => padRight(h, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));

  for (const item of all) {
    const mode = config.isLauncherServer(item.cfg) ? 'launcher' : 'plaintext';
    const warnings = [];
    if (mode !== 'launcher' && isPlaintextEnvServer(item.cfg)) warnings.push('⚠ plaintext env vars present');
    console.log(
      [
        padRight(item.name, widths[0]),
        padRight(item.enabled ? 'yes' : 'no', widths[1]),
        padRight(mode, widths[2]),
        padRight(warnings.join(', '), widths[3]),
      ].join('  '),
    );
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(usage());
    return;
  }

  try {
    if (cmd === 'add') return await cmdAdd(rest[0], rest[1]);
    if (cmd === 'remove') return await cmdRemove(rest[0]);
    if (cmd === 'rotate') return await cmdRotate(rest[0], rest[1]);
    if (cmd === 'list') return await cmdList();
    if (cmd === 'inject') return await cmdInject();
    if (cmd === 'status') return await cmdStatus();

    die(`Unknown command: ${cmd}\n\n${usage()}`);
  } catch (err) {
    die(err?.message || String(err));
  }
}

main();

