#!/bin/bash
# ─────────────────────────────────────────────────────────────
# SETUP_GITHUB.command
# Kør dette ÉN gang for at koble dashboardet til GitHub.
# Herefter sker deploys og synk automatisk — ingen manuel handling.
# ─────────────────────────────────────────────────────────────

set -e
cd /Users/simonleohansen/omar-dashboard

echo ""
echo "═══════════════════════════════════════════════"
echo "   Omar Dashboard — GitHub opsætning"
echo "═══════════════════════════════════════════════"
echo ""

# Tjek at git er installeret
if ! command -v git &>/dev/null; then
  echo "❌ Git er ikke installeret. Installer det fra https://git-scm.com"
  read -n 1; exit 1
fi

# Tjek at GitHub CLI er installeret
if ! command -v gh &>/dev/null; then
  echo "📦 Installerer GitHub CLI..."
  brew install gh
fi

# Log ind på GitHub hvis nødvendigt
echo "🔑 Logger ind på GitHub..."
gh auth status 2>/dev/null || gh auth login

# Initialiser git repo
if [ ! -d .git ]; then
  echo "📂 Initialiserer git repository..."
  git init
  git branch -M main
fi

# Opret .gitignore hvis den mangler essentielle linjer
grep -q "node_modules" .gitignore 2>/dev/null || echo "node_modules/" >> .gitignore

# Stage og commit alle filer
echo "📝 Forbereder første commit..."
git add -A
git diff --cached --quiet || git commit -m "Initial commit: Omar Dashboard"

# Opret GitHub repository (privat)
REPO_NAME="omar-dashboard"
echo ""
echo "🐙 Opretter privat GitHub repository: $REPO_NAME"
if gh repo view "simonleohansen/$REPO_NAME" &>/dev/null 2>&1; then
  echo "   Repository eksisterer allerede — bruger det."
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/simonleohansen/$REPO_NAME.git"
else
  gh repo create "$REPO_NAME" --private --source=. --remote=origin --push
fi

# Push til GitHub
echo "🚀 Pusher kode til GitHub..."
git push -u origin main --force

echo ""
echo "═══════════════════════════════════════════════"
echo "   ✅ GitHub opsætning fuldført!"
echo ""
echo "   Næste skridt (2 min i browseren):"
echo ""
echo "   1. Gå til: https://vercel.com/dashboard"
echo "   2. Klik på 'omar-dashboard' projektet"
echo "   3. Settings → Git → Connect Git Repository"
echo "   4. Vælg GitHub → simonleohansen/omar-dashboard"
echo "   5. Klik Connect"
echo ""
echo "   Herefter deployer Vercel automatisk ved"
echo "   hver kodeændring — ingen manuel deploy mere!"
echo "═══════════════════════════════════════════════"
echo ""
read -n 1 -p "Tryk på en tast for at åbne Vercel i browseren..."
open "https://vercel.com/dashboard"
