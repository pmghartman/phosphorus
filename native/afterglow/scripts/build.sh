#!/usr/bin/env bash
# afterglow built and staged, in an MSYS2 UCRT64 shell (its packages in
# .github/workflows/afterglow.yml): afterglow.exe and its service, the shaders it
# compiles at run time, zlib1.dll that OpenSSL loads, the licence and where the
# source is. The signed SudoVDA driver package is staged by the workflow after it.
# usage: build.sh OUT_DIR [VERSION]
set -euo pipefail
OUT=$(realpath -m "$1")
VER=${2:-0.0.0}
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"

# Apollo's version logic reads these; no git describe in a submodule-less tree
export BRANCH=phosphorus BUILD_VERSION="$VER" COMMIT="${GITHUB_SHA:-local}"
cmake -B build -G Ninja -S . \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_DOCS=OFF \
  -DBUILD_TESTS=OFF
# the CMake targets keep Apollo's names; their outputs are afterglow.exe and afterglowsvc.exe
ninja -C build sunshine sunshinesvc

# the link's own tests, the one part built from phosphorus's sources alone
c++ -std=c++20 -Wall -Wextra -Werror -Isrc test/wire_test.cpp -o build/wire_test.exe
./build/wire_test.exe

rm -rf "$OUT"
mkdir -p "$OUT/tools" "$OUT/assets" "$OUT/drivers/sudovda"
cp build/afterglow.exe "$OUT/"
cp build/tools/afterglowsvc.exe "$OUT/tools/"
cp -R src_assets/windows/assets/. "$OUT/assets/"
cp src_assets/windows/drivers/sudovda/install.bat src_assets/windows/drivers/sudovda/uninstall.bat "$OUT/drivers/sudovda/"
cp "$(dirname "$(command -v cmake)")/zlib1.dll" "$OUT/"
cp LICENSE "$OUT/LICENSE.txt"
cp NOTICE "$OUT/NOTICE.txt"
cat > "$OUT/SOURCE.txt" <<TXT
afterglow $VER: phosphorus's streaming host, a fork of Apollo
(https://github.com/ClassicOldSong/Apollo), itself a fork of LizardByte's Sunshine.
GNU General Public License version 3 (LICENSE.txt). Its complete source, with the
changes phosphorus made, is native/afterglow in https://github.com/pmghartman/phosphorus
at commit ${GITHUB_SHA:-unknown}.
TXT
strip "$OUT/afterglow.exe" "$OUT/tools/afterglowsvc.exe" || true
ls -la "$OUT" "$OUT/tools"
