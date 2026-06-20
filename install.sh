#!/usr/bin/env bash
# pi-deeplooper installer wrapper

set -euo pipefail

REPO_REF="${PI_DEEPLOOPER_REF:-git:github.com/n3m6/pi-deeplooper@main}"

if ! command -v pi >/dev/null 2>&1; then
  echo "ERROR: pi is required to install pi-deeplooper." >&2
  echo "Install pi first, then run:" >&2
  echo "  pi install $REPO_REF" >&2
  exit 1
fi

echo "==> Installing pi-deeplooper via pi"
pi install "$REPO_REF"

echo "==> Done. Open a new pi session and run:"
echo "      /deeplooper <task>"
