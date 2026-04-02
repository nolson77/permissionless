# Permissionless — Phase 1 Build Brief
**Credential Management for MCP Servers**
_Prepared for Cursor · March 16, 2026_

---

## What This Project Is

Permissionless is a local-only, zero-dependency tool that:
1. Stores MCP API keys and tokens securely in macOS Keychain (never in plaintext)
2. Injects those credentials at MCP spawn time via a Node launcher embedded in `claude_desktop_config.json`
3. Tracks credential metadata (assignment, rotation age, last used)
4. Surfaces credentials in a simple UI at `localhost:3000/credentials`

**Phase 1 scope:** credential store + launcher generator + CLI + UI. No proxy, no activity logging (that's Phase 2).

---

## What Already Exists

**Codebase location:** `~/Developer/permissionless/`

The `src/` directory contains v1 files — `logger.js` and `http-bridge.js`. These are the **old proxy approach and are being retired in Phase 1.** Do not modify them. Do not route new MCPs through them. They can remain on disk for reference but should no longer appear in `claude_desktop_config.json`.

---

## Locked Design Decisions

| Decision | Value |
|---|---|
| Storage backend | macOS Keychain via `/usr/bin/security` CLI — no npm packages |
| Runtime injection | Node launcher embedded in `claude_desktop_config.json` args array |
| Node path (confirmed working) | `/usr/local/bin/node` |
| npx path (confirmed working) | `/usr/local/bin/npx` |
| Keychain service name | `permissionless` |
| Config file path | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Zero npm dependencies | Strict — use only Node.js built-ins (`child_process`, `fs`, `crypto`, `path`, `os`) |

---

## File Architecture to Build

```
~/Developer/permissionless/
├── src/
│   ├── keychain.js          ← NEW: read/write/delete Keychain via /usr/bin/security
│   ├── launcher.js          ← NEW: generates the Node launcher string for config injection
│   ├── config-manager.js    ← NEW: reads/writes claude_desktop_config.json
│   ├── metadata.js          ← NEW: credential metadata tracker (JSON file on disk)
│   ├── logger.js            ← OLD: leave untouched, no longer used in config
│   └── http-bridge.js       ← OLD: leave untouched, no longer used in config
├── cli.js                   ← NEW: CLI entry point
├── server.js                ← EXISTING or NEW: Express server for UI
├── public/
│   └── credentials.html     ← NEW: credential list view
└── package.json             ← update scripts section
```

---

## Module Specs

### 1. `src/keychain.js`

The foundation. All credential reads/writes go through this module. Uses only `child_process.execFile` — no npm packages.

```js
// API surface:
keychain.set(account, secret)    // stores secret in Keychain under service "permissionless"
keychain.get(account)            // returns secret string, throws with clear message if not found
keychain.delete(account)         // removes item from Keychain
keychain.list()                  // returns array of account names stored under "permissionless"
```

**Implementation notes:**
- Use `/usr/bin/security` — full path, never rely on PATH
- `set`: `security add-generic-password -s permissionless -a <account> -w <secret> -U`
  - The `-U` flag updates if the item already exists — important for rotation
- `get`: `security find-generic-password -s permissionless -a <account> -w`
  - Exit code 44 = item not found. Throw a clear, user-readable error: `"No credential found for '<account>'. Run: permissionless add <account>"`
- `delete`: `security delete-generic-password -s permissionless -a <account>`
- `list`: parse `security dump-keychain` output filtered by service name `permissionless`
- All methods return Promises (async/await). Never use sync variants.
- **Never log the secret value** — log account names only.

---

### 2. `src/launcher.js`

Generates the inline Node.js `-e` script that gets embedded in `claude_desktop_config.json`. This is what replaces both the proxy files and the plaintext env values.

The launcher's job at MCP spawn time:
1. Call `/usr/bin/security find-generic-password` to fetch the secret
2. Set it as an environment variable in the current process
3. `execFileSync` the real MCP command (npx, node, etc.) with that env variable live

```js
// API surface:
launcher.generate(options)
// options: {
//   envVarName: "NOTION_API_KEY",
//   keychainAccount: "NOTION_API_KEY",
//   mcpCommand: "/usr/local/bin/npx",
//   mcpArgs: ["-y", "@notionhq/notion-mcp-server"]
// }
// returns: the string to embed in config's "args" array after "-e"
```

**The generated launcher string should:**
- Use only built-in Node modules (no require of anything external)
- Fetch secret via `child_process.execFileSync('/usr/bin/security', [...])`
- Set `process.env[envVarName] = secret.trim()`
- Then `child_process.execFileSync(mcpCommand, mcpArgs, { stdio: 'inherit', env: process.env })`
- On error (key not found, exit 44), print a clear message to stderr and exit with code 1

---

### 3. `src/config-manager.js`

Reads and writes `claude_desktop_config.json`. Knows how to inject launchers and how to strip them back out.

```js
// API surface:
config.read()                    // returns parsed JSON of current config
config.write(obj)                // safely writes config (validates JSON before writing)
config.injectLauncher(mcpName, launcherArgs)
// replaces the mcpName server entry's command/args/env with the Node launcher
config.stripLaunchers()
// reverse: reads Keychain accounts and restores plaintext env for all managed MCPs
// (useful for debugging or emergency rollback)
config.backup()
// writes a timestamped backup to ~/Developer/permissionless/config-backups/
```

**Config path:** `~/Library/Application Support/Claude/claude_desktop_config.json`

**Safety rules:**
- Always `config.backup()` before any write operation
- Never write a config that fails `JSON.parse()` — validate first
- Preserve all existing config keys (especially the `preferences` block) — never overwrite the whole file
- When injecting a launcher, the resulting MCP entry looks like:

```json
"notion": {
  "command": "/usr/local/bin/node",
  "args": ["-e", "<generated launcher string>"],
  "env": {}
}
```

Note: `env` becomes an empty object — secrets are no longer passed via env in the config.

---

### 4. `src/metadata.js`

Tracks non-secret metadata about each credential. Stored as a JSON file at `~/Developer/permissionless/credential-metadata.json`.

```js
// Schema per credential:
{
  "account": "NOTION_API_KEY",
  "mcp_assignment": ["notion"],
  "date_added": "2026-03-16",
  "last_rotated": "2026-03-16",
  "last_used": null,           // updated at MCP spawn time in Phase 2
  "source": "keychain"
}

// API surface:
metadata.get(account)
metadata.set(account, fields)  // upsert
metadata.delete(account)
metadata.list()                // returns all entries
metadata.markRotated(account)  // updates last_rotated to today
```

---

### 5. `cli.js`

Entry point: `node ~/Developer/permissionless/cli.js <command> [args]`

**Commands:**

```
permissionless add <account> <secret>
  → keychain.set(account, secret)
  → metadata.set(account, { date_added: today, source: "keychain" })
  → prints: "✓ <account> stored in Keychain"

permissionless remove <account>
  → keychain.delete(account)
  → metadata.delete(account)
  → prints: "✓ <account> removed"

permissionless rotate <account> <new-secret>
  → keychain.set(account, new-secret)   // -U flag handles update
  → metadata.markRotated(account)
  → prints: "✓ <account> rotated. Update any services that use this key."

permissionless list
  → metadata.list() combined with keychain.list()
  → prints a table: account | mcp | date added | last rotated | age (days)

permissionless inject
  → for each account in metadata: config.injectLauncher(mcpName, launcher.generate(...))
  → config.backup() first
  → prints: "✓ Config updated. Restart Claude Desktop to apply."

permissionless status
  → reads current config and shows which MCPs are using launchers vs. plaintext
  → flags any MCPs with plaintext env vars as warnings
```

**Important:** The `add` command should warn if a secret is passed directly on the command line
(it will appear in shell history). Offer an interactive prompt alternative.

---

### 6. UI — `public/credentials.html`

Simple credential list view served at `localhost:3000/credentials`.

**What to show per credential:**
- Account name (e.g., `NOTION_API_KEY`)
- MCP assignment(s) (e.g., `notion`)
- Date added
- Last rotated
- Rotation age in days — highlight red if > 90 days
- Status: `🔒 In Keychain` or `⚠️ Plaintext in config` (read from config-manager)

**Actions per row:**
- Rotate (opens a form to paste new secret → calls CLI rotate)
- Remove

No frameworks. Plain HTML, vanilla JS, inline CSS. Keep it minimal — this is a utility UI, not a product.

**API endpoints needed in `server.js`:**
```
GET  /api/credentials        → metadata.list() + status from config-manager
POST /api/credentials        → add new credential
POST /api/credentials/rotate → rotate existing
DELETE /api/credentials/:account → remove
POST /api/inject             → run config injection
```

---

## Build Order

Build in this sequence — each step depends on the previous:

1. **`src/keychain.js`** — foundation, no dependencies
2. **`src/metadata.js`** — no dependencies beyond `fs`
3. **`src/launcher.js`** — depends on knowing node path (hardcoded: `/usr/local/bin/node`)
4. **`src/config-manager.js`** — depends on `launcher.js`
5. **`cli.js`** — depends on all four modules above
6. **`server.js` + `public/credentials.html`** — depends on `cli.js` modules

Test each module in isolation with a simple smoke test before moving to the next.

---

## Three MCPs to Migrate (after build)

Once the build is complete and keys have been rotated, these are the three MCPs to migrate:

| MCP Name in Config | Env Var | Keychain Account Name |
|---|---|---|
| `notion` | `NOTION_API_KEY` | `NOTION_API_KEY` |
| `linear-server` | `LINEAR_API_KEY` | `LINEAR_API_KEY` |
| `github` | `GITHUB_PERSONAL_ACCESS_TOKEN` | `GITHUB_PERSONAL_ACCESS_TOKEN` |

The Notion and GitHub MCPs currently route through `logger.js`. After migration, they will call `npx` directly — same packages, same args, no proxy in the middle.

**Notion launcher args:**
```
mcpCommand: "/usr/local/bin/npx"
mcpArgs: ["-y", "@notionhq/notion-mcp-server"]
```

**GitHub launcher args:**
```
mcpCommand: "/usr/local/bin/npx"
mcpArgs: ["-y", "@modelcontextprotocol/server-github"]
```

**Linear launcher args:**
```
mcpCommand: "/usr/local/bin/npx"
mcpArgs: ["-y", "@linear/mcp-server"]   ← confirm this package name before running
```
Linear currently uses `http-bridge.js` which proxies to `https://mcp.linear.app/mcp`. Verify whether Linear's MCP server has a published npm package or still requires the HTTP bridge approach — this may need investigation before migrating Linear.

---

## Definition of Done

A user can:
1. Run `permissionless add NOTION_API_KEY <secret>` and have it stored in macOS Keychain
2. Run `permissionless inject` and have `claude_desktop_config.json` rewritten with Node launchers — no plaintext keys anywhere in the file
3. Restart Claude Desktop with **zero popup warnings** about MCP connections
4. Run `permissionless list` and see rotation age and MCP assignment for all credentials
5. Open `localhost:3000/credentials` and see a clean credential dashboard
6. Rotate a key without touching the config file at all

---

## Constraints — Do Not Violate

- **Zero npm dependencies** — only Node.js built-ins
- **Never write plaintext secrets to disk** — not in logs, not in config backups, not in metadata
- **Always backup config before writing** — `config-backups/` directory
- **Full paths only** — `/usr/local/bin/node`, `/usr/bin/security`, etc. Never rely on PATH
- **Preserve the `preferences` block** in `claude_desktop_config.json` on every write
- **Do not modify `logger.js` or `http-bridge.js`** — leave them as v1 artifacts

---

_End of Phase 1 Build Brief_
