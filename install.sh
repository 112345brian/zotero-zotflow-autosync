#!/usr/bin/env bash
# Packages bootstrap.js + manifest.json into an XPI and installs it into
# the Zotero profile. Quit Zotero before running; restart it afterwards.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
XPI="$PLUGIN_DIR/zotflow-autosync.xpi"
PROFILE="$HOME/Library/Application Support/Zotero/Profiles/k5g8xid6.default"

echo "Building $XPI ..."
rm -f "$XPI"
(cd "$PLUGIN_DIR" && zip -j "$XPI" manifest.json bootstrap.js)

echo "Copying to Zotero profile ..."
cp "$XPI" "$PROFILE/extensions/zotflow-autosync@local.xpi"

echo ""
echo "Done. Start Zotero — it will prompt to install the extension."
echo "Check Tools → Add-ons to confirm it appears as 'ZotFlow Auto-Sync'."
