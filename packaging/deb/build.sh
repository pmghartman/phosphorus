#!/bin/sh
# Linux package: the release and its binary under /usr/lib/phosphorus, the bundled tools
# under /usr/libexec/phosphorus, the service's and update agent's units, the apt feed
# Usage: packaging/deb/build.sh OUT.deb VER PAYLOAD ARCH (amd64|arm64) BIN TOOLS (packaging/tools.sh linux)   Env: PHOSPHORUS_APT_KEY (binary keyring)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:?usage: packaging/deb/build.sh OUT.deb VER PAYLOAD ARCH BIN TOOLS}
VER=$2 PAYLOAD=$3 ARCH=${4:?ARCH amd64 or arm64} BIN=${5:?BIN the linux/ARCH phosphorus binary}
TOOLS=${6:?TOOLS packaging/tools.sh output}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
chmod 755 "$T"
install -d "$T/usr/lib/phosphorus"
cp -a "$PAYLOAD/." "$T/usr/lib/phosphorus/"
chmod -R u=rwX,go=rX "$T/usr/lib/phosphorus"
install -Dm755 "$BIN" "$T/usr/lib/phosphorus/bin/phosphorus"
# the licenses where Debian looks for them too
install -Dm644 "$PAYLOAD/LICENSE" "$T/usr/share/doc/phosphorus/copyright"
for f in THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.txt; do install -Dm644 "$PAYLOAD/$f" "$T/usr/share/doc/phosphorus/$f"; done
for t in tailscale tailscaled cloudflared forgejo; do install -Dm755 "$TOOLS/$t" "$T/usr/libexec/phosphorus/$t"; done
for u in phosphorus.service phosphorus-tailscaled.service phosphorus-update.path phosphorus-update.service; do
    install -Dm644 "$HERE/$u" "$T/usr/lib/systemd/system/$u"
done
install -d "$T/DEBIAN"
for s in postinst prerm postrm; do install -m755 "$HERE/$s" "$T/DEBIAN/$s"; done
# flat apt repo on the rolling `update` release
if [ -n "${PHOSPHORUS_APT_KEY:-}" ]; then
    install -Dm644 "$PHOSPHORUS_APT_KEY" "$T/usr/share/keyrings/phosphorus.gpg"
    install -d "$T/etc/apt/sources.list.d"
    echo "deb [signed-by=/usr/share/keyrings/phosphorus.gpg] https://github.com/pmghartman/phosphorus/releases/download/update ./" >"$T/etc/apt/sources.list.d/phosphorus.list"
    echo /etc/apt/sources.list.d/phosphorus.list >"$T/DEBIAN/conffiles"
fi
cat > "$T/DEBIAN/control" <<CTL
Package: phosphorus
Version: $VER
Architecture: $ARCH
Maintainer: Phosphorus <https://github.com/pmghartman/phosphorus>
Depends: openssh-server, sudo
Recommends: rsync, sqlite3, git, ripgrep, libgomp1, curl, iproute2, ca-certificates
Installed-Size: $(du -sk --exclude=DEBIAN "$T" | cut -f1)
Section: misc
Priority: optional
Homepage: https://github.com/pmghartman/phosphorus
Description: one service per machine, a mesh of hosts
 The phosphorus host: its services published, the others' polled, one web UI and cli.
 Runs under systemd with tailscale, cloudflared and forgejo bundled, no containers.
CTL
dpkg-deb --root-owner-group -Zxz --build "$T" "$OUT" >/dev/null
echo "package: $OUT"
