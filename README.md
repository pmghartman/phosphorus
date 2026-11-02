<img src="apps/web/static/phosphorus-ascii.svg" alt="" width="280">

# Phosphorus

**A self-hosted service installer for every computer you own.**

<p>
  <a href="https://github.com/pmghartman/phosphorus/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/pmghartman/phosphorus?style=flat-square&color=a371f7"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/pmghartman/phosphorus?style=flat-square&color=f0883e"></a>
  <img alt="platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555?style=flat-square">
</p>

Install Phosphorus on each machine and they find each other over your tailnet. Then pick an app, see at a glance whether it installs, and install it with one click onto any host. Choose one or more backup hosts, and if the main one goes down a backup takes over.

> **Status:** Phosphorus is being reshaped around the installer. Items marked *(in progress)* are being built on `main` now and are not in a release yet.

## Quick start

1. Grab Phosphorus from the [**latest release**](https://github.com/pmghartman/phosphorus/releases/latest); it has install steps for every platform.
2. On each machine, give it a free [Tailscale](https://tailscale.com) auth key when `phos` asks.
3. Run `phos`. It shows this host's state and a link to the web desktop; open that link from any device on your tailnet.

## Core

What every install has.

- **App installer** *(in progress)*. Browse apps from the catalogues below, or paste any public GitHub repo that has a Compose file. Each app's page shows its README, its files and its Compose file, then runs a quick check: images for your hosts' CPU, free ports, the settings it needs, and anything risky (privileged, host network). If it passes, install it onto the host you pick with one click. It runs under Docker Compose with its data kept in one folder, and its page gets its own subdomain.
- **Backup hosts** *(in progress)*. When installing, pick one or more standby hosts. They keep a fresh copy of the app's data and take over automatically if the main host fails. "Move to host…" hands an app over cleanly for maintenance.
- **Your own services, found.** Web pages already listening on any host are found and can be published on the mesh in one click, behind the Phosphorus login or public.
- **Terminal.** One tabbed window that opens a shell on any host.
- **Files.** Your folders on each host *(being simplified, with one home synced to every host, in progress)*.
- **Settings** *(in progress)*. Profile, appearance, users, agents, hosts and their status, updates, about.
- **An MCP server**, so Claude can work your mesh for you.
- **Mesh updates.** Every host updated from one place.

## Optional apps

Off by default. An admin installs them from the Apps page, and every host serves its own copy, signed and checked before it runs.

| App | What it does | Status |
|---|---|---|
| Sulfur | A code editor for the whole mesh, by [rpmull](https://github.com/rpmull/sulfur) | available |
| Code | Claude Code or opencode sessions on any host | moving out of the core |
| Chat | Mesh-wide chat with channels and direct messages | moving out of the core |
| Git | A Forgejo server for the mesh, with failover | moving out of the core |
| Games | Game servers you start and stop from the desktop, with join addresses | moving out of the core |
| Viewer | Images, video, audio and PDFs, plus a text editor | moving out of the core |

Each optional app lives in [`optional/<id>`](optional) and is built into a signed bundle with `bun run app <id> OUT VERSION`.

## App catalogues

The installer reads these catalogues at run time, fetching them from their own repos on your host. Their files are never copied into this repo, and every app shows its source and licence.

| Catalogue | Licence | Used |
|---|---|---|
| [CasaOS App Store](https://github.com/IceWhaleTech/CasaOS-AppStore) | Apache-2.0 | yes |
| [Runtipi App Store](https://github.com/runtipi/runtipi-appstore) | GPL-3.0 | yes, fetched at run time only |
| [Cosmos servapps](https://github.com/azukaar/cosmos-servapps-official) | AGPL-3.0 | yes, fetched at run time only |
| Umbrel apps | none stated | no |

App logos belong to their projects and are loaded from the catalogue, not shipped.

## The `phos` command

Kept small on purpose; everything else is in the web desktop.

```
phos            this host's state and the link to the web desktop (asks for keys on a new host)
phos keys       change this host's keys (Tailscale, domain, tunnel, admin password)
phos start | stop | restart
phos status
phos update     update this host
phos uninstall
phos version | help
```

## Repository layout

| Path | What's there |
|---|---|
| [`apps/`](apps) | The programs that ship: `host` (the `phosphorus` binary and `phos`), `tray` (macOS and Windows menu-bar app), `web` (the desktop page) |
| [`packages/`](packages) | The core's libraries, by area: `core` (shared types, theme, app SDK), `mesh` (peers, store, election, installer, updates, users), `net`, `host`, `home`, `server`, `ai`, `chat` |
| [`optional/`](optional) | Optional apps, one folder each, built into signed bundles |
| [`scripts/`](scripts) | Build, test, licences, icons and app bundles |
| [`packaging/`](packaging) | Installers for each platform |
| [`config/`](config) | Per-host config defaults: `phosphorus.ini`, `services.export` |

```bash
bun install
bun run check   # dependency links and types
bun run test
bun run web     # build the desktop page
```

## License

Apache 2.0, see [`LICENSE`](LICENSE). Bundled software keeps its own license; full texts ship in each installer as `THIRD_PARTY_NOTICES.txt`, generated at build time by `bun run licenses`.

<p align="center">
  <img src=".github/assets/wright-alchemist.jpg" alt="The Alchemist Discovering Phosphorus, Joseph Wright of Derby" width="420">
</p>

<p align="center"><sub><i>The Alchymist, In Search of the Philosopher's Stone, Discovers Phosphorus</i>, Joseph Wright of Derby, 1771: Hennig Brand in 1669. Public domain, via <a href="https://commons.wikimedia.org/wiki/File:Joseph_Wright_of_Derby_The_Alchemist.jpg">Wikimedia Commons</a>.</sub></p>
