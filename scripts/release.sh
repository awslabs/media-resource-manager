#!/bin/bash
# release.sh - Bump version, sync to frontend, commit, tag, and push
#
# Usage:
#   ./scripts/release.sh patch    # 1.0.0 -> 1.0.1
#   ./scripts/release.sh minor    # 1.0.0 -> 1.1.0
#   ./scripts/release.sh major    # 1.0.0 -> 2.0.0
#   ./scripts/release.sh 1.2.3    # Set explicit version

set -e

BUMP_TYPE="${1:-patch}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Get current version
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
echo "Current version: $CURRENT_VERSION"

# Bump version
if [[ "$BUMP_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  # Explicit version
  NEW_VERSION="$BUMP_TYPE"
  npm version "$NEW_VERSION" --no-git-tag-version
else
  # Bump type (patch, minor, major)
  npm version "$BUMP_TYPE" --no-git-tag-version
  NEW_VERSION=$(node -e "console.log(require('./package.json').version)")
fi

# Sync to frontend
npm run version-sync

echo "New version: $NEW_VERSION"

# Commit and tag
git add package.json package-lock.json frontend/package.json frontend/package-lock.json
git commit -m "release: v${NEW_VERSION}"
git tag "v${NEW_VERSION}"

echo ""
echo "✅ Version bumped to $NEW_VERSION"
echo ""
echo "To publish the release:"
echo "  git push origin main --tags"
echo "  Then create a GitHub Release from tag v${NEW_VERSION}"
