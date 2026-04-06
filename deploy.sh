#!/bin/bash
# Omar Dashboard — deploy til Vercel production
cd /Users/simonleohansen/omar-dashboard
echo "📂 Deployer fra: $(pwd)"
echo "🚀 Kører: vercel --prod"
vercel --prod
echo "✅ Deployment afsluttet"
