function generate(options) {
  const {
    envVarName,
    keychainAccount,
    mcpCommand,
    mcpArgs,
  } = options || {};

  if (!envVarName || typeof envVarName !== 'string') {
    throw new Error('launcher.generate: options.envVarName is required');
  }
  if (!keychainAccount || typeof keychainAccount !== 'string') {
    throw new Error('launcher.generate: options.keychainAccount is required');
  }
  if (!mcpCommand || typeof mcpCommand !== 'string') {
    throw new Error('launcher.generate: options.mcpCommand is required');
  }
  if (!Array.isArray(mcpArgs)) {
    throw new Error('launcher.generate: options.mcpArgs must be an array');
  }

  // This string is embedded as the argument after Node's "-e" in Claude's config.
  // It must be self-contained: only built-in Node modules, no project requires.
  return [
    "'use strict';",
    "const child_process = require('child_process');",
    "function fail(msg) { try { process.stderr.write(String(msg).trim() + '\\n'); } catch {} process.exit(1); }",
    "let secret = '';",
    "try {",
    `  secret = child_process.execFileSync('/usr/bin/security', ['find-generic-password','-s','permissionless','-a',${JSON.stringify(keychainAccount)},'-w'], { encoding: 'utf8' });`,
    "} catch (e) {",
    "  const code = typeof e.status === 'number' ? e.status : (typeof e.code === 'number' ? e.code : null);",
    `  if (code === 44) fail("No credential found for '${keychainAccount}'. Run: permissionless add ${keychainAccount}");`,
    "  fail('Failed to load credential from Keychain (' + (code ?? 'unknown') + ').');",
    "}",
    `process.env[${JSON.stringify(envVarName)}] = String(secret || '').trim();`,
    "try {",
    `  child_process.execFileSync(${JSON.stringify(mcpCommand)}, ${JSON.stringify(mcpArgs)}, { stdio: 'inherit', env: process.env });`,
    "} catch (e) {",
    "  const code = typeof e.status === 'number' ? e.status : 1;",
    "  process.exit(code);",
    "}",
  ].join('\n');
}

module.exports = { generate };

