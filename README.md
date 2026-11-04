<img src="apps/web/static/phosphorus-ascii.svg" alt="" width="280">

# Phosphorus

<p>
  <a href="https://github.com/pmghartman/phosphorus/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/pmghartman/phosphorus?style=flat-square&color=a371f7"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/pmghartman/phosphorus?style=flat-square&color=f0883e"></a>
  <img alt="platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555?style=flat-square">
</p>

Self-hosted apps on every computer you own: install one onto any host in a click, with backup hosts that take over if it fails.

Each machine runs one Phosphorus service. They find each other over your [Tailscale](https://tailscale.com) tailnet, keep a full copy of the mesh's settings, and serve one web desktop from any of them.

## Quick start

1. Install the [latest release](https://github.com/pmghartman/phosphorus/releases/latest) on each machine (`.deb`, `.dmg` or setup `.exe`).
2. Run `phos` and give it a Tailscale auth key. Every other host copies the rest from the mesh.
3. Open the link it prints from any device on your tailnet. The first login is `admin`.

## What it does

- **Services.** Apps from the CasaOS, Runtipi and Cosmos catalogues, Phosphorus's own (Forgejo), or any public repo with a Compose file. Each one is checked before install (images for your CPUs, free ports, risky settings), runs under Docker Compose with its data in one folder, and gets its own subdomain.
- **Standby hosts.** Picked at install, they keep a fresh copy of a service's data and take over if its host fails.
- **Found pages.** Web servers already listening on a host can be published on the mesh, behind the login or public.
- **Desktop.** Terminal on any host, Files across hosts' shares, Settings, mesh-wide updates.
- **Optional apps.** Code, Chat, Games and Viewer in [`optional/`](optional), signed bundles an admin installs.
- **MCP server**, so Claude can run the mesh for you.

## `phos`

```
phos            this host's state and the desktop link (asks for keys on a new host)
phos keys       change this host's keys
phos start | stop | restart | status
phos update     update this host (every host: settings › update)
phos uninstall
```

## On disk

`/var/lib/phosphorus` on Linux, `~/Library/Phosphorus` on macOS, `%USERPROFILE%\phosphorus` on Windows.

```
bin/        the phosphorus binary (a link to the package's on Linux)
sys/        the store every host holds a full copy of, root only
  etc/        users, hosts, services, stacks, chat, models
  etc/hosts/<host>/config.json   a host's settings: shares, model, stacks
  var/        this host's own: chat media, the home sync's index
home/       each user's files and shared/
stacks/     installed services, one folder each
state/      this host's own: logs, caches, the baked env, update status
.env        keys, root only
```

A host's settings are edited in settings › hosts or with the MCP `config_set` tool, from any host.

## Repository

```
apps        host (phosphorus, phos), tray, the web desktop
packages    the core's libraries: core, mesh, net, host, home, server, ai
optional    code, chat, games, viewer
scripts     build, test, licences, icons, app bundles
packaging   installers per platform
```

```bash
bun install
bun run check   # dependency links and types
bun run test
bun run web     # the desktop page
```

Apache 2.0, see [`LICENSE`](LICENSE). Bundled software keeps its own licence; full texts ship as `THIRD_PARTY_NOTICES.txt`.

<p align="center">
  <img src=".github/assets/wright-alchemist.jpg" alt="The Alchemist Discovering Phosphorus, Joseph Wright of Derby" width="420">
</p>

<p align="center"><sub><i>The Alchymist, In Search of the Philosopher's Stone, Discovers Phosphorus</i>, Joseph Wright of Derby, 1771: Hennig Brand in 1669. Public domain, via <a href="https://commons.wikimedia.org/wiki/File:Joseph_Wright_of_Derby_The_Alchemist.jpg">Wikimedia Commons</a>.</sub></p>
