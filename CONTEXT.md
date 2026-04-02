# Permissionless — Minimum Viable Context
*Session handoff document — last updated 2026-03-09*

---

## Vision

**"Access management that feels like there are none."**

Permissionless is a local-only web app for managing the permissions you've granted to AI agents (Claude, ChatGPT, Devin, GitHub Copilot, etc.). The design ethos is Jobs-era Apple: no backend dependencies, no accounts, no cloud — just a beautiful, iOS-native-feeling dashboard that runs on your machine and gives you a clear, auditable picture of what every agent can touch and why.

The app is deliberately zero-dependency (vanilla Node.js + vanilla JS), fast to run, and designed to feel more like a native Mac app than a web tool. The UI language borrows directly from iOS: SF Pro fonts, the Apple color token system (`--primary: #007AFF`, `--green: #34C759`, etc.), bottom tab bar, blur/frosted-glass headers, card-based layout, and smooth cubic-bezier transitions throughout.

**The problem it solves:** As you give more AI agents access to more tools (MCPs, APIs, shared logins), you lose track of who has access to what, at what risk level, and whether those permissions are still needed. Permissionless is your audit log and control panel.

---

## Project Location

```
~/Documents/Python/permissionless/
├── src/
│   └── server.js          ← Node.js HTTP server (no framework, ~400 lines)
├── public/
│   └── index.html         ← Full single-page app (~1,500 lines, all inline)
├── data.json              ← Live data store (gitignored — stays local)
├── mcp_tools.json         ← Per-tool permission settings per MCP
├── package.json           ← "npm start" / "npm run dev"
├── setup-repo.sh          ← One-time GitHub push script
└── .gitignore             ← Excludes data.json, node_modules, .env
```

**To run:** `cd ~/Documents/Python/permissionless && node src/server.js`
**URL:** `http://localhost:3000`
**Git remote:** `https://github.com/nolson77/permissionless`
**Git log:** 2 commits — `Initial commit — permissionless v0.1.0`, `Add setup script`

---

## Data Model

All data lives in `data.json` (runtime, gitignored). The schema has two top-level arrays:

### Agents
```json
{
  "id": "claude",
  "name": "Claude",
  "provider": "Anthropic",
  "type": "assistant",       // "assistant" | "engineer" | etc.
  "icon": "🧠",
  "status": "active",
  "created": "2026-03-08"
}
```

**Current agents:** Claude (Anthropic), ChatGPT (OpenAI), Devin (Cognition), GitHub Copilot (GitHub)

### Permissions
```json
{
  "id": "p1",
  "agent_id": "claude",
  "tool": "Notion MCP",
  "platform": "Local",           // "Local" | "Apple" | "Claude Native" | "Other"
  "login_type": "MCP Token",     // "MCP Token" | "API Key" | "Password" | "OAuth"
  "access_level": "Editor",      // "Admin" | "Editor" | "Viewer" | "Custom"
  "scopes": "...",               // Free text — what exactly this grants
  "purpose": "...",              // Why this permission exists
  "risk_level": "Low",           // "Low" | "Medium" | "High"
  "status": "Active",            // "Active" | "Inactive" | "Needs Review"
  "granted_date": "2026-03-08",
  "last_verified": null,
  "two_fa_enabled": false,
  "notes": "..."
}
```

**Current permissions (7 total):**
| ID | Agent | Tool | Risk | Status |
|----|-------|------|------|--------|
| p1 | Claude | Notion MCP | Low | Active |
| p2 | Claude | Linear MCP | Low | Active |
| p3 | Claude | GitHub MCP | Medium | Active |
| p4 | Devin | GitHub PAT | Medium | Inactive |
| p5 | ChatGPT | Quickbooks (shared) | High | Active |
| p6 | ChatGPT | DocuSign (shared) | Medium | Active |
| p7 | Claude | Gmail MCP | Medium | Active |

---

## Tool-Level Permissions (`mcp_tools.json`)

A secondary data file (not gitignored, can be committed) that stores per-tool permission settings for each MCP. Format:

```json
{
  "notion": [
    { "name": "notion-update-page", "label": "Update page", "permission": "always_ask" },
    { "name": "notion-search",      "label": "Search",      "permission": "always_allow" }
  ]
}
```

**Currently populated for:** `gmail`, `notion`, `linear`, `github`
Permissions: `"always_allow"` | `"always_ask"` | (implicitly) `"deny"`

---

## Server API (`src/server.js`)

Zero-dependency Node.js HTTP server on port 3000. All routes are under `/api/`.

### Dashboard
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/dashboard` | Summary stats: totalAgents, activePermissions, highRiskCount, neverVerifiedCount, attention items |

### Agents
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents` | List all agents with permission counts |
| POST | `/api/agents` | Create new agent |
| PUT | `/api/agents/:id` | Update agent |
| DELETE | `/api/agents/:id` | Delete agent + cascade-delete its permissions |

### Permissions
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/permissions?agent_id=` | List permissions (optionally filtered by agent) |
| POST | `/api/permissions` | Create permission |
| PUT | `/api/permissions/:id` | Update permission |
| DELETE | `/api/permissions/:id` | Delete permission |

### MCP Manager (reads/writes `claude_desktop_config.json`)
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/mcp` | List all MCPs (active + disabled) from Claude Desktop config |
| POST | `/api/mcp` | Add new MCP to Claude Desktop config |
| PUT | `/api/mcp/:name/toggle` | Enable ↔ disable an MCP (moves between `mcpServers` / `disabled_mcpServers`) |
| PUT | `/api/mcp/:name` | Update MCP config (env vars, args) |
| DELETE | `/api/mcp/:name` | Remove MCP from Claude Desktop config |

### Tool Permissions (reads/writes `mcp_tools.json`)
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/mcp/:name/tools` | Get tool list for an MCP |
| PUT | `/api/mcp/:name/tools` | Bulk replace tool list |
| PUT | `/api/mcp/:name/tools/:toolName` | Update single tool's permission setting |

Also: `GET /api/claude-config` — returns raw Claude Desktop config JSON.

---

## Frontend (`public/index.html`)

Single HTML file, ~1,500 lines, fully inline CSS + JS. No build step, no frameworks.

### Navigation Structure
Two tabs (bottom tab bar, iOS-style):
- **Home tab** → Dashboard → Agent Detail → Permission Detail
- **MCPs tab** → MCP Manager → MCP Detail → Edit MCP Env

### Views / Screens
| View | Key Function | Description |
|------|-------------|-------------|
| `dashboard` | `renderDashboard()` | Stats cards, attention items, agent list, Claude MCP quick-list |
| `agent-detail` | `renderAgentDetail()` | Agent's active/inactive permissions, verify-all banner |
| `permission-detail` | `renderPermissionDetail()` | Full permission record, verify/revoke/restore actions |
| `mcp-manager` | `renderMCPManager()` | List all MCPs from Claude config, toggle enable/disable |
| `mcp-detail` | `renderMCPDetail()` | MCP config details, per-tool permission settings, edit env vars, delete |
| `add-mcp` | `renderAddMCP()` | Form to add a new MCP (command, args, env vars) |
| `add-agent` | `renderAddAgent()` | Form to add a new agent |
| `add-permission` | `renderAddPermission()` | Form to add a permission to an agent |
| `edit-mcp-env` | `renderEditMCPEnv()` | Edit env vars for an existing MCP |

### State Model
```js
state = {
  view: 'dashboard',       // current view name
  tab: 'home',             // 'home' | 'mcps'
  agent: null,             // current agent object
  permission: null,        // current permission object
  currentMCP: null,        // current MCP name (for MCP detail)
  viewHistory: []          // stack for back navigation
}
```

### Key Actions Available in UI
- Mark a permission as verified (`markVerified`)
- Revoke (deactivate) or restore a permission
- Delete agent (cascades to permissions)
- Toggle MCP on/off (writes to Claude Desktop config)
- Set per-tool permissions (always allow / always ask)
- Add/edit MCP env vars
- FAB (floating action button) for context-sensitive add actions

---

## What's Built vs. What's Not

### ✅ Done
- Full CRUD for agents and permissions
- Dashboard with stats + attention flags (high risk, undocumented scopes)
- Agent detail view with permission breakdown
- Permission detail with verify/revoke/restore
- MCP Manager: reads live Claude Desktop config, toggle enable/disable, add/remove MCPs
- Tool-level permission settings (always allow / always ask) per MCP
- Edit MCP env vars (API keys etc.) in-app
- iOS-clean UI with Apple design tokens, animations, bottom tab nav
- Data persistence via local JSON files
- GitHub repo initialized, 2 commits pushed

### 🔲 Not Yet Built / Known Gaps
- No authentication (app is local-only, which is intentional)
- No bulk import (e.g., scan all connected tools and auto-populate)
- No export / report generation
- No reminders / scheduled re-verification prompts
- `last_verified` is tracked but there's no UI to set a re-verify cadence
- "Shared password" warnings shown in notes but not surfaced as a distinct risk category
- Native Claude connectors (Gmail, etc.) show up in permissions but not in the MCPs tab (they're not in `claude_desktop_config.json`)
- No dark mode (uses light Apple HIG palette only)
- The `setup-repo.sh` GitHub push step has not been confirmed to have run successfully

---

## Key Design Decisions / Constraints

1. **Zero dependencies** — no npm packages, no build step. `node src/server.js` is all it takes.
2. **Local-only** — data never leaves the machine. The app reads/writes files directly on disk.
3. **Single HTML file** — the entire frontend is `public/index.html`. No components, no bundler.
4. **Claude Desktop config integration** — the MCP Manager reads and writes `~/Library/Application Support/Claude/claude_desktop_config.json` directly. Changes take effect on Claude restart.
5. **data.json is gitignored** — permissions are private and stay local. Only the app code is committed.
6. **Aesthetic** — Apple HIG / iOS. SF Pro fonts, the exact iOS color variables, blur headers, card-based layout. The name "Permissionless" is a deliberate play: permission management that feels invisible.
