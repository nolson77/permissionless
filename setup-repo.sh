#!/bin/bash
# Run this once from inside the permissionless/ folder
# Requires: node (built-in on Mac), gh CLI (brew install gh)

set -e

echo "🔐 Setting up permissionless repo..."

# 1. Init git
git init
git branch -M main
git config user.name "Nick Olson"
git config user.email "nick_olson@mac.com"

# 2. Stage files (data.json is gitignored — your real permissions stay local)
git add src/server.js public/index.html package.json .gitignore
git commit -m "Initial commit — permissionless v0.1.0

Zero-dependency local web app for managing AI agent permissions.
Reads Claude Desktop MCP config, tracks agents and access grants,
flags high-risk and unverified permissions. iOS-clean UI."

# 3. Create GitHub repo and push
#    gh will prompt you to authenticate if needed
gh repo create permissionless \
  --public \
  --description "A local permission management layer for AI agents and connected apps" \
  --source=. \
  --remote=origin \
  --push

echo ""
echo "✅ Done! Your repo is live at: https://github.com/nolson77/permissionless"
echo ""
echo "To run the app:"
echo "  node src/server.js"
echo "  → open http://localhost:3000"
