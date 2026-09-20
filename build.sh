#!/usr/bin/env bash
# Bundle src/hook-filter.ts into plugins/jev-sift/hook.js (single file, needs only node at runtime)
# and copy the status line script into the plugin. Run `npm install` once first.
set -e
cd "$(dirname "$0")"
node_modules/.bin/esbuild src/hook-filter.ts --bundle --platform=node --target=node18 --format=cjs --minify --outfile=plugins/jev-sift/hook.js --log-level=error
cp scripts/statusline.sh plugins/jev-sift/scripts/statusline.sh
echo "built plugins/jev-sift/hook.js ($(wc -c < plugins/jev-sift/hook.js | tr -d ' ') bytes)"
