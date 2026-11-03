<img src="apps/web/static/phosphorus-ascii.svg" alt="" width="280">

# Phosphorus

<p>
  <a href="https://github.com/pmghartman/phosphorus/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/pmghartman/phosphorus?style=flat-square&color=a371f7"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/pmghartman/phosphorus?style=flat-square&color=f0883e"></a>
  <img alt="platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555?style=flat-square">
</p>

Self-hosted apps on every computer you own: install one onto any host in a click, with backup hosts that take over if it fails.

1. Install the [latest release](https://github.com/pmghartman/phosphorus/releases/latest) on each machine.
2. Run `phos` and give it a [Tailscale](https://tailscale.com) auth key.
3. Open the link it prints from any device on your tailnet.

```
phosphorus
|- apps        host, tray and the web desktop
|- packages    the core's libraries
|- optional    code, chat, games, viewer
|- scripts     build and test
|- packaging   installers
|- config      per-host defaults
```

Apache 2.0, see [`LICENSE`](LICENSE).

<p align="center">
  <img src=".github/assets/wright-alchemist.jpg" alt="The Alchemist Discovering Phosphorus, Joseph Wright of Derby" width="420">
</p>
