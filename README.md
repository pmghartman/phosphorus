<p align="center">
  <img src="apps/web/static/phosphorus-ascii.svg" alt="" width="280">
</p>

<h1 align="center">Phosphorus</h1>

<p align="center">
  Self-hosted apps on every computer you own: install one onto any host in a click,<br>
  with backup hosts that take over if it fails.
</p>

<p align="center">
  <a href="https://github.com/pmghartman/phosphorus/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/pmghartman/phosphorus?style=flat-square&color=a371f7"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/pmghartman/phosphorus?style=flat-square&color=f0883e"></a>
  <img alt="platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555?style=flat-square">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#the-phos-command">The phos command</a> ·
  <a href="#where-things-live">Where things live</a> ·
  <a href="#development">Development</a>
</p>

---

Each machine runs one Phosphorus service. They find each other over your [Tailscale](https://tailscale.com) tailnet, each keeps a full copy of the mesh's settings, and any of them serves the same web desktop.

## Quick start

1. **Install** the [latest release](https://github.com/pmghartman/phosphorus/releases/latest) on each machine: `.deb` (Linux), `.dmg` (macOS) or setup `.exe` (Windows).
2. **Join the mesh.** Run `phos` and give it a Tailscale auth key. Every other host copies the rest from the mesh.
3. **Open the desktop** at the link it prints, from any device on your tailnet. The first login is `admin`.

## Features

| | |
| --- | --- |
| **Services** | Apps from the CasaOS, Runtipi and Cosmos catalogues, Phosphorus's own (Forgejo), or any public repo with a Compose file. Each one is checked before install (images for your CPUs, free ports, risky settings), runs under Docker Compose with its data in one folder, and gets its own subdomain. |
| **Standby hosts** | Picked at install, they keep a fresh copy of a service's data and take over if its host fails. |
| **Found pages** | Web servers already listening on a host can be published on the mesh, behind the login or public. |
| **Desktop** | Terminal on any host, Files across hosts' shares, Settings, mesh-wide updates. |
| **Optional apps** | Code, Chat, Games and Viewer in [`optional/`](optional), signed bundles an admin installs. |
| **MCP server** | Lets Claude run the mesh for you. |

## The `phos` command

| Command | What it does |
| --- | --- |
| `phos` | This host's state and the desktop link. Asks for keys on a new host. |
| `phos keys` | Change this host's keys. |
| `phos start` · `stop` · `restart` · `status` | Control the service on this host. |
| `phos update` | Update this host. To update every host, use settings › update. |
| `phos uninstall` | Remove Phosphorus from this host. |

A host's settings are edited in settings › hosts, or with the MCP `config_set` tool, from any host.

## Where things live

| OS | Folder |
| --- | --- |
| Linux | `/var/lib/phosphorus` |
| macOS | `~/Library/Phosphorus` |
| Windows | `%USERPROFILE%\phosphorus` |

<details>
<summary>What's inside it</summary>

| Path | Holds |
| --- | --- |
| `bin/` | The phosphorus binary (a link to the package's on Linux). |
| `sys/` | The store every host holds a full copy of. Root only. |
| `sys/etc/` | Users, hosts, services, stacks, chat, models. |
| `sys/etc/hosts/<host>/config.json` | A host's settings: shares, model, stacks. |
| `sys/var/` | This host's own: chat media, the home sync's index. |
| `home/` | Each user's files, and `shared/`. |
| `stacks/` | Installed services, one folder each. |
| `state/run/` | What the service writes about itself: its baked env, locks, roles. |
| `state/log/` | `phosphorus.log`, the MCP audit, each `phos` command's output. |
| `state/cache/` | Catalogue indexes, app icons, model weights, tailscale and cloudflared. Safe to delete. |
| `state/data/` | Installed apps and their data, standby rosters, update history. Its root holds only what other programs and versions read there. |
| `.env` | Keys. Root only. |

</details>

## Development

Needs [Bun](https://bun.sh).

```bash
bun install
bun run check   # dependency links and types
bun run test
bun run web     # build the desktop page
```

| Folder | Contents |
| --- | --- |
| [`apps/`](apps) | The host (`phosphorus`, `phos`), the tray, the web desktop. |
| [`packages/`](packages) | The core's libraries: core, mesh, net, host, home, server, ai. |
| [`optional/`](optional) | Code, Chat, Games, Viewer. |
| [`scripts/`](scripts) | Build, test, licenses, icons, app bundles. |
| [`packaging/`](packaging) | Installers per platform. |

## License

Apache 2.0, see [`LICENSE`](LICENSE). Bundled software keeps its own license; the full texts ship as `THIRD_PARTY_NOTICES.txt`.

<p align="center">
  <img src=".github/assets/wright-alchemist.jpg" alt="The Alchemist Discovering Phosphorus, Joseph Wright of Derby" width="420">
</p>

<p align="center"><sub><i>The Alchymist, In Search of the Philosopher's Stone, Discovers Phosphorus</i>, Joseph Wright of Derby, 1771: Hennig Brand in 1669. Public domain, via <a href="https://commons.wikimedia.org/wiki/File:Joseph_Wright_of_Derby_The_Alchemist.jpg">Wikimedia Commons</a>.</sub></p>
