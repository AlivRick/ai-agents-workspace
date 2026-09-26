#!/usr/bin/env bash
# Dua ban vua build (npm run release:win) len GitHub Releases. App da cai se
# thay latest.json o releases/latest, tai setup.exe, kiem chu ky roi tu cai.
# Chay: npm run publish:win -- "ghi chu ban nay"
set -euo pipefail

REPO=AlivRick/ai-agents-workspace
V=$(node -p 'require("./src-tauri/tauri.conf.json").version')
NSIS=src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis
SETUP="$NSIS/Agentspace_${V}_x64-setup.exe"
PORTABLE=src-tauri/target/x86_64-pc-windows-msvc/release/agentspace.exe
NOTES="${1:-Agentspace $V}"

[ -f "$SETUP" ] && [ -f "$SETUP.sig" ] || { echo "chua co $SETUP(.sig) — chay npm run release:win truoc" >&2; exit 1; }
gh release view "v$V" -R "$REPO" >/dev/null 2>&1 && { echo "v$V da phat hanh roi — tang version trong tauri.conf.json" >&2; exit 1; }

TMP=$(mktemp -d)
cp "$PORTABLE" "$TMP/Agentspace-portable-x64.exe"
# Ten co dinh, de trang gioi thieu tro vao releases/latest/download/... ma khong phai sua theo version.
cp "$SETUP" "$TMP/Agentspace-setup-x64.exe"
# URL tai day la ten file tren release; GitHub doi dau cach thanh dau cham nen ten khong co dau cach.
V="$V" NOTES="$NOTES" SIG="$(cat "$SETUP.sig")" URL="https://github.com/$REPO/releases/download/v$V/$(basename "$SETUP")" node -e '
  const e = process.env;
  process.stdout.write(JSON.stringify({ version: e.V, notes: e.NOTES, pub_date: new Date().toISOString(),
    platforms: { "windows-x86_64": { signature: e.SIG, url: e.URL } } }, null, 2));
' > "$TMP/latest.json"

gh release create "v$V" -R "$REPO" --title "Agentspace $V" --notes "$NOTES" \
  "$SETUP" "$TMP/Agentspace-setup-x64.exe" "$TMP/Agentspace-portable-x64.exe" "$TMP/latest.json"
rm -rf "$TMP"
echo "da phat hanh v$V"
