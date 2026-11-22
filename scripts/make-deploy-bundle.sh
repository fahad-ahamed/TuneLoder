#!/bin/bash
# Stage the TuneLoad deploy bundle from the standalone build, PRUNING the
# file-tracing pollution Next copies in (data/, download/, skills/, src/ …).
# NO SECRETS inside — cookies + tgbot.json already live on the container.
set -euo pipefail
cd /home/z/my-project

STANDALONE=.next/standalone

# ---- prune pollution Next's file tracing pulled into standalone ----
for junk in data download skills db src examples tests test-results tool-results upload prisma mini-services \
            Caddyfile dev.log server.log bun.lock components.json postcss.config.mjs \
            tailwind.config.ts tsconfig.json tsconfig.tsbuildinfo bgutil-server.log \
            .env .env.example .tmp-downloads .git .zscripts eslint.config.mjs ; do
  rm -rf "$STANDALONE/$junk" || true
done

STAGE=/tmp/tuneload-stage
rm -rf "$STAGE"
mkdir -p "$STAGE/data/cookies" "$STAGE/data/audio" "$STAGE/.tmp-downloads" "$STAGE/bin"

# pruned standalone runtime (server.js + node_modules + .next incl. static + public)
cp -r "$STANDALONE/." "$STAGE/"

# engine + bot scripts
mkdir -p "$STAGE/scripts"
cp scripts/tgbot.mjs scripts/start.sh "$STAGE/scripts/"
cp scripts/bd_boot.sh "$STAGE/.bd_boot.sh"
chmod +x "$STAGE/.bd_boot.sh" "$STAGE/scripts/start.sh"

# PO-token provider (plugin for yt-dlp + built server runtime)
mkdir -p "$STAGE/bgutil-ytdlp-pot-provider/server"
cp -r bgutil-ytdlp-pot-provider/plugin "$STAGE/bgutil-ytdlp-pot-provider/" 2>/dev/null || true
cp -r bgutil-ytdlp-pot-provider/server/build "$STAGE/bgutil-ytdlp-pot-provider/server/" 2>/dev/null || true

# env template (no secrets)
cat > "$STAGE/.env.example" << 'EOF'
ADMIN_PASSWORD=fahad
MAX_CONCURRENCY=1
EOF

echo "stage: $(du -sh "$STAGE" | cut -f1)"
tar -czf /home/z/my-project/download/tuneload-deploy-bundle.tar.gz -C "$STAGE" .
echo "bundle: $(du -h /home/z/my-project/download/tuneload-deploy-bundle.tar.gz | cut -f1)"
echo "--- top-level entries ---"
tar -tzf /home/z/my-project/download/tuneload-deploy-bundle.tar.gz | awk -F/ 'NF>1{print $2}' | sort -u
