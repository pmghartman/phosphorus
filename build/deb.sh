#!/bin/sh
# Linux package: the release under /opt/hesperus, the update agent's units, the apt feed
# Usage: build/deb.sh OUT.deb VER PAYLOAD   Env: HESPERUS_APT_KEY (binary public keyring)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:?usage: build/deb.sh OUT.deb VER PAYLOAD}
VER=$2 PAYLOAD=$3
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
chmod 755 "$T"
install -d "$T/opt/hesperus"
cp -a "$PAYLOAD/." "$T/opt/hesperus/"
chmod -R u=rwX,go=rX "$T/opt/hesperus"
for u in hesperus-update.path hesperus-update.service; do
    install -Dm644 "$HERE/deb/$u" "$T/usr/lib/systemd/system/$u"
done
install -d "$T/DEBIAN"
for s in postinst prerm postrm; do install -m755 "$HERE/deb/$s" "$T/DEBIAN/$s"; done
# flat apt repo on the rolling `update` release
if [ -n "${HESPERUS_APT_KEY:-}" ]; then
    install -Dm644 "$HESPERUS_APT_KEY" "$T/usr/share/keyrings/hesperus.gpg"
    install -d "$T/etc/apt/sources.list.d"
    echo "deb [signed-by=/usr/share/keyrings/hesperus.gpg] https://github.com/pmghartman/hesperus/releases/download/update ./" >"$T/etc/apt/sources.list.d/hesperus.list"
    echo /etc/apt/sources.list.d/hesperus.list >"$T/DEBIAN/conffiles"
fi
cat > "$T/DEBIAN/control" <<CTL
Package: hesperus
Version: $VER
Architecture: all
Maintainer: Hesperus <https://github.com/pmghartman/hesperus>
Depends: docker.io | docker-ce, docker-compose-v2 | docker-compose-plugin | docker-compose, openssh-server, sudo
Installed-Size: $(du -sk --exclude=DEBIAN "$T" | cut -f1)
Section: misc
Priority: optional
Homepage: https://github.com/pmghartman/hesperus
Description: one container per machine, a mesh of hosts
 The hesperus host: its services published, the others' polled, one web UI and cli.
CTL
dpkg-deb --root-owner-group -Zxz --build "$T" "$OUT" >/dev/null
echo "package: $OUT"
