#!/usr/bin/env bash
set -euo pipefail

# Magic Context — Interactive Setup
# Usage: curl -fsSL https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/scripts/install.sh | bash

PACKAGE="@cortexkit/opencode-magic-context"

main() {
  echo ""
  echo "  ✨ Magic Context — Setup"
  echo "  ────────────────────────"
  echo ""

  # Detect runtime
  if command -v bun &>/dev/null; then
    echo "  → Using bun"
    echo ""
    bunx --bun "$PACKAGE" setup </dev/tty
  elif command -v npx &>/dev/null; then
    # Check Node version — @clack/prompts requires styleText from node:util (Node >= 20.12)
    NODE_VERSION=$(node -v 2>/dev/null | sed 's/^v//')
    NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
    NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
    if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
      echo "  ✗ Node.js $NODE_VERSION is too old (requires >= 20.12)"
      echo ""
      echo "  Options:"
      echo "    • Install bun (recommended): curl -fsSL https://bun.sh/install | bash"
      echo "    • Upgrade Node.js: https://nodejs.org"
      echo ""
      exit 1
    fi
    echo "  → Using npx (Node $NODE_VERSION)"
    echo ""
    npx -y "$PACKAGE" setup </dev/tty
  else
    echo "  ✗ Neither bun nor npx found."
    echo ""
    echo "  Install one of:"
    echo "    • bun:  curl -fsSL https://bun.sh/install | bash"
    echo "    • node: https://nodejs.org (>= 20.12)"
    echo ""
    exit 1
  fi
}

main "$@"
