#!/usr/bin/env bash
# Build xong thi phai nam tren Desktop, khong thi coi nhu chua build.
set -euo pipefail

DEST="${AGENTSPACE_DEST:-/mnt/c/Users/Administrator/Desktop/Agentspace}"
SRC="src-tauri/target/x86_64-pc-windows-msvc/release"

[ -f "$SRC/agentspace.exe" ] || { echo "chua build: khong thay $SRC/agentspace.exe" >&2; exit 1; }
mkdir -p "$DEST"

# Windows khong cho ghi de mot exe dang chay, nhung cho DOI TEN no. Doi ten
# truoc roi moi chep de con copy duoc trong luc app van dang mo.
[ -f "$DEST/Agentspace-portable-x64.exe" ] &&
  mv -f "$DEST/Agentspace-portable-x64.exe" "$DEST/Agentspace-portable-x64.old.exe"

cp "$SRC/agentspace.exe" "$DEST/Agentspace-portable-x64.exe"
cp "$SRC"/bundle/nsis/*_x64-setup.exe "$DEST/"

echo "da chep ra $DEST:"
ls -la --time-style=+%H:%M "$DEST"/*.exe
