#!/bin/sh
# Linux package: the release under /usr/lib/phosphorus, the update agent's units, the apt feed
# Usage: build/deb.sh OUT.deb VER PAYLOAD ARCH (amd64|arm64)   Env: PHOSPHORUS_APT_KEY (binary keyring)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:?usage: build/deb.sh OUT.deb VER PAYLOAD ARCH}
VER=$2 PAYLOAD=$3 ARCH=${4:?ARCH amd64 or arm64}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
chmod 755 "$T"
install -d "$T/usr/lib/phosphorus"
cp -a "$PAYLOAD/." "$T/usr/lib/phosphorus/"
chmod -R u=rwX,go=rX "$T/usr/lib/phosphorus"
for u in phosphorus-update.path phosphorus-update.service; do
    install -Dm644 "$HERE/deb/$u" "$T/usr/lib/systemd/system/$u"
done
install -d "$T/DEBIAN"
for s in postinst prerm postrm; do install -m755 "$HERE/deb/$s" "$T/DEBIAN/$s"; done
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
Depends: docker.io | docker-ce, docker-compose-v2 | docker-compose-plugin | docker-compose, openssh-server, sudo
Suggests: xpra, xpra-html5
Installed-Size: $(du -sk --exclude=DEBIAN "$T" | cut -f1)
Section: misc
Priority: optional
Homepage: https://github.com/pmghartman/phosphorus
Description: one container per machine, a mesh of hosts
 The phosphorus host: its services published, the others' polled, one web UI and cli.
CTL
dpkg-deb --root-owner-group -Zxz --build "$T" "$OUT" >/dev/null
echo "package: $OUT"
