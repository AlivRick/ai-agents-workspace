#!/usr/bin/env bash
# Build xong thi phai nam tren Desktop, khong thi coi nhu chua build.
set -euo pipefail

DEST="${AGENTSPACE_DEST:-/mnt/c/Users/Administrator/Desktop/Agentspace}"
SRC="src-tauri/target/x86_64-pc-windows-msvc/release"

[ -f "$SRC/agentspace.exe" ] || { echo "chua build: khong thay $SRC/agentspace.exe" >&2; exit 1; }
mkdir -p "$DEST"

# Windows khong cho ghi de mot exe dang chay, nhung cho DOI TEN no. Doi ten
# truoc roi moi chep de con copy duoc trong luc app van dang mo.
#
# Ten cu phai la ten MOI moi lan: mot ban .old.exe da tung chay van con bi
# Windows khoa, nen `mv -f` de len no chet o buoc xoa dich. Don rac truoc, bo
# qua cai nao khong xoa duoc.
rm -f "$DEST"/*.old.exe 2>/dev/null || true
[ -f "$DEST/Agentspace-portable-x64.exe" ] &&
  mv -f "$DEST/Agentspace-portable-x64.exe" \
        "$DEST/Agentspace-portable-x64.$(date +%H%M%S).old.exe"

cp "$SRC/agentspace.exe" "$DEST/Agentspace-portable-x64.exe"
cp "$SRC"/bundle/nsis/*_x64-setup.exe "$DEST/"

echo "da chep ra $DEST:"
ls -la --time-style=+%H:%M "$DEST"/*.exe
