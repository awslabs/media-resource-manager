#!/bin/bash
# install-test-deps.sh - Install per-lambda node_modules needed by the jest suite.
#
# The unit tests import lambda handlers directly (e.g.
# `require('../lambda/jwt-authorizer/index.js')`). Those handlers declare their
# own dependencies in per-lambda package.json files that npm does not hoist to
# the root node_modules. deploy.sh installs them at deploy time; this script
# does the same at test time.
#
# Idempotent: skips lambdas whose node_modules already exists. Safe to run on
# every test invocation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

for pkg in lambda/*/package.json; do
  [[ -f "$pkg" ]] || continue
  d="$(dirname "$pkg")"
  name="$(basename "$d")"
  if [[ -d "$d/node_modules" ]]; then
    continue
  fi
  echo "  Installing test deps for lambda/$name..."
  (cd "$d" && npm install --no-audit --no-fund --silent)
done
