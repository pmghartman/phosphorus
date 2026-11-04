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
  <a href="#access-from-anywhere-with-cloudflare">Cloudflare</a> ·
  <a href="#the-phos-command">The phos command</a> ·
  <a href="#where-things-live">Where things live</a>
</p>

---

Each machine runs one Phosphorus service. They find each other over your [Tailscale](https://tailscale.com) tailnet, each keeps a full copy of the mesh's settings, and any of them serves the same web desktop.

## Quick start

**Before you begin**

- A free [Tailscale](https://tailscale.com) account, and a **reusable auth key** from its admin console (settings › keys). Keys expire every 90 days.
- Docker on each machine that will run services. Phosphorus installs it for you on Debian and Ubuntu; elsewhere, install Docker Desktop first.

**1. Install on your first machine.** Download the [latest release](https://github.com/pmghartman/phosphorus/releases/latest) for it: the `.deb` for Linux, the `.dmg` for macOS (Apple silicon) or the setup `.exe` for Windows, and install it as usual.

**2. Run `phos`** in a terminal. On a new host it asks for its keys:

| Key | Needed? | What it's for |
| --- | --- | --- |
| Tailscale auth key | Yes | Joins this machine to your tailnet. |
| Admin password | Yes, on the first host | The setup login, and the confirmation for mesh-wide updates. |
| Domain and Cloudflare tunnel token | Optional | Access from outside your tailnet, see [Cloudflare](#access-from-anywhere-with-cloudflare). |
| Tailscale API token | Optional | Join keys for guests. |

**3. Open the desktop** at the link `phos` prints, from any device on your tailnet. Log in as `admin` with the admin password, create your own admin account, then log in as that.

**4. Add your other machines.** Install the release on each and run `phos`. Only the Tailscale auth key is needed; leave the rest blank and the host copies them from the mesh. It shows up on the desktop within moments.

**5. Install your first service** from the catalogue on the desktop: pick the host it runs on, and optionally standby hosts to take over if that one fails.

## Features

| | |
| --- | --- |
| **Services** | Apps from the CasaOS, Runtipi and Cosmos catalogues, Phosphorus's own (Forgejo), or any public repo with a Compose file. Each one is checked before install (images for your CPUs, free ports, risky settings), runs under Docker Compose with its data in one folder, and gets its own subdomain. |
| **Standby hosts** | Picked at install, they keep a fresh copy of a service's data and take over if its host fails. |
| **Found pages** | Web servers already listening on a host can be published on the mesh, behind the login or public. |
| **Desktop** | Terminal on any host, Files across hosts' shares, Settings, mesh-wide updates. |
| **Optional apps** | Code, Chat, Games and Viewer in [`optional/`](optional), signed bundles an admin installs. |
| **Cloudflare tunnel** | Optional: the desktop and services on your own domain, reachable from anywhere. |
| **MCP server** | Lets AI assistants and agents run the mesh for you, through any MCP client. |

## Access from anywhere with Cloudflare

Optional. Without it, everything is reachable only from devices on your tailnet.

1. Add your domain to [Cloudflare](https://www.cloudflare.com) and create a tunnel (Zero Trust › networks › tunnels).
2. Give the tunnel two public hostnames, `<domain>` and `*.<domain>`, both pointing to `http://localhost:80`.
3. Enter the domain and the tunnel's token when `phos` asks on your first host, or later with `phos keys` on each host. Hosts that join afterwards copy both from the mesh. Every host with the token runs the tunnel, so the domain keeps working while any of them is up.

The desktop is then at `<domain>` and each service at its own subdomain, behind the Phosphorus login unless you make it public.

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

## License

Apache 2.0, see [`LICENSE`](LICENSE). Bundled software keeps its own license; the full texts ship as `THIRD_PARTY_NOTICES.txt`.

<p align="center">
  <img src=".github/assets/wright-alchemist.jpg" alt="The Alchemist Discovering Phosphorus, Joseph Wright of Derby" width="420">
</p>

<p align="center"><sub><i>The Alchymist, In Search of the Philosopher's Stone, Discovers Phosphorus</i>, Joseph Wright of Derby, 1771: Hennig Brand in 1669. Public domain, via <a href="https://commons.wikimedia.org/wiki/File:Joseph_Wright_of_Derby_The_Alchemist.jpg">Wikimedia Commons</a>.</sub></p>
