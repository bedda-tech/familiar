#!/bin/bash
# Release script for Familiar
# Usage: ./scripts/release.sh [patch|minor|major]
#   or:  ./scripts/release.sh <version>  (e.g., 0.5.0)
#
# Steps:
#   1. Verify clean working tree
#   2. Build and verify
#   3. Read version from package.json (already bumped)
#   4. Commit, tag, push
#   5. Create GitHub release from CHANGELOG
#   6. Publish to npm

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
RESET='\033[0m'

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

step() { echo -e "\n${BOLD}${GREEN}→${RESET} ${BOLD}$1${RESET}"; }
warn() { echo -e "${YELLOW}⚠ $1${RESET}"; }
fail() { echo -e "${RED}✗ $1${RESET}"; exit 1; }

# --- 1. Check working tree ---
step "Checking working tree"
if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes:"
  git status --short
  echo ""
  read -rp "Commit all changes before release? [y/N] " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    VERSION=$(node -p "require('./package.json').version")
    git add -A
    git commit -m "chore: prepare v${VERSION} release

Update README, CHANGELOG, bump version to ${VERSION}.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
  else
    fail "Clean working tree required. Commit or stash changes first."
  fi
fi

# --- 2. Build ---
step "Building"
npm run build
echo -e "${GREEN}✓${RESET} Build succeeded"

# --- 3. Read version ---
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
step "Releasing ${TAG}"

# Check tag doesn't already exist
if git rev-parse "$TAG" >/dev/null 2>&1; then
  fail "Tag ${TAG} already exists. Bump version in package.json first."
fi

# --- 4. Tag and push ---
step "Tagging ${TAG}"
git tag -a "$TAG" -m "Release ${TAG}"
echo -e "${GREEN}✓${RESET} Tagged ${TAG}"

step "Pushing to origin"
git push origin HEAD
git push origin "$TAG"
echo -e "${GREEN}✓${RESET} Pushed"

# --- 5. GitHub release ---
step "Creating GitHub release"
# Extract changelog section for this version
CHANGELOG_SECTION=$(awk "/^## \\[${VERSION}\\]/{found=1; next} /^## \\[/{if(found) exit} found{print}" CHANGELOG.md)

if [ -z "$CHANGELOG_SECTION" ]; then
  warn "No changelog section found for ${VERSION}, using tag message"
  gh release create "$TAG" --title "$TAG" --generate-notes
else
  gh release create "$TAG" --title "$TAG" --notes "$CHANGELOG_SECTION"
fi
echo -e "${GREEN}✓${RESET} GitHub release created"

# --- 6. Publish to npm ---
step "Publishing to npm"
read -rp "Publish @bedda/familiar@${VERSION} to npm? [y/N] " answer
if [[ "$answer" =~ ^[Yy]$ ]]; then
  npm publish
  echo -e "${GREEN}✓${RESET} Published to npm"
else
  warn "Skipped npm publish. Run 'npm publish' manually when ready."
fi

echo -e "\n${BOLD}${GREEN}✓ Release ${TAG} complete!${RESET}"
echo "  GitHub: https://github.com/bedda-tech/familiar/releases/tag/${TAG}"
echo "  npm:    https://www.npmjs.com/package/@bedda/familiar"
