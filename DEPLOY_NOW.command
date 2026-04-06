#!/bin/bash
# ─────────────────────────────────────────────────────────────
# DEPLOY_NOW.command
# Deployer ændringer til Vercel via git push → auto-deploy.
# Kræver at SETUP_GITHUB.command er kørt én gang først.
# ─────────────────────────────────────────────────────────────

set -e
cd /Users/simonleohansen/omar-dashboard

echo ""
echo "🚀 Deployer omar-dashboard..."
echo ""

# Tjek om git og GitHub er sat op
if [ ! -d .git ]; then
  echo "❌ Git er ikke sat op. Kør SETUP_GITHUB.command først."
  read -n 1; exit 1
fi

# Commit alle ændringer og push → Vercel deployer automatisk
git add -A
if git diff --cached --quiet; then
  echo "✅ Ingen nye ændringer — koden er allerede deployed."
else
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
  git commit -m "Dashboard opdatering $TIMESTAMP"
  echo "📤 Pusher til GitHub..."
  git push origin main
  echo ""
  echo "✅ Pushed! Vercel deployer automatisk inden for ~30 sekunder."
  echo "   Følg deploy på: https://vercel.com/dashboard"
fi

echo ""
read -n 1 -p "Tryk på en tast for at lukke..."
