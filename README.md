<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/wordmark-dark.svg">
    <img src=".github/assets/wordmark-light.svg" alt="phosphorus" width="440">
  </picture>
</p>

<p align="center">
  <img src=".github/assets/wright-alchemist.jpg" alt="The Alchemist in Search of the Philosopher's Stone, Joseph Wright of Derby" width="420">
  <br>
  <sub><i>The Alchemist in Search of the Philosopher's Stone</i>, Joseph Wright of Derby, 1771. Public domain, via <a href="https://commons.wikimedia.org/wiki/File:Joseph_Wright_of_Derby_The_Alchemist.jpg">Wikimedia Commons</a>.</sub>
</p>

Phosphorus turns every computer you own into one shared desktop in the browser.
Install it on each machine (a **host**), and every host's terminals, files, web
services, chat and status show up together at your domain.

## Install

Download the installer for your system from the
[latest release](https://github.com/pmghartman/phosphorus/releases/latest):

| System | You need first | Then |
|---|---|---|
| Linux (Debian, Ubuntu) | nothing | `sudo apt install ./phosphorus_VERSION_amd64.deb` (or `arm64`) |
| macOS | [colima](https://github.com/abiosoft/colima) and Homebrew `docker`, `docker-compose` | open the `.dmg`, drag Phosphorus to Applications, right-click > Open |
| Windows | Docker Desktop, with host networking on | run the setup `.exe` (SmartScreen: More info > Run anyway) |

Then open the `.env` file in the host's folder, fill it in from `.env.example`
(your domain and Tailscale keys), and start it: `sudo phosphorus start` on Linux,
or Start in the tray icon on macOS and Windows.

The host's folder: `/var/lib/phosphorus` (Linux), `~/Library/Phosphorus` (macOS),
`%USERPROFILE%\phosphorus` (Windows). Updates never touch your settings or files there.
Tailscale keys expire every 90 days.

Everything through your domain needs a phosphorus login, every service's page and
subdomain included (a page you open logged out sends you to log in, then back), so
no Cloudflare Access policy is needed. The git server is the exception, behind only
its own login so git clients reach it. Five wrong passwords from one address lock it
out for 15 minutes. Hosts reach each other over the tailnet, outside the login.

## Using it

Open your domain in a browser and log in with your phosphorus user. On first start
there are no users: log in as `admin` with `ADMIN_PASS` from `.env`
and make an admin user (the setup admin turns off once one exists). Admins add and
delete users and give out admin from the users icon.

The first time a user logs in they log in to one or more hosts with that machine's
own user and password; those logins are saved to their profile for next time. A
host online but not logged in shows a lock in the bottom bar: click it to log in.
The profile button in the bar holds saved hosts, page logins, the password and log out.
Your chat name is your user name, and your theme, icon layout, wallpaper, recent
files and chat colour belong to you, not the browser: they follow you to any browser,
and another user logging in on yours never sees them.

Each host's `files/home/sys/` is the mesh's own small file system, no user's to open: `etc/` (users in `passwd`
and `shadow`, the model roles and API keys in `model/`, chat channels in `chat/`, what
each host publishes about itself in `hosts/<host>/`, files kept on every host in
`mirror/`) and `home/<user>/` (the vault, sealed with that user's password, and
settings) are copied to every host; `var/` (chat) is the host's own. You get a desktop:

- **files**: every host's shared folders; copy and move between hosts, drag files in to upload
- **home**: every host's `home/` folder (in `files/` unless `[home]` says otherwise) as one:
  your own (only you can open it, admins included), `shared/` for everyone, `sys/` for
  no one, and admin files at the top. Each file lives on the
  host you pick when you add it, or on all hosts (32MB at most, kept in step); a host
  that's offline shows its files greyed. Your `Desktop/` and `shared/Desktop/` are on
  your desktop. Pages, `.wasm` programs and `NAME.app` folders (with an `index.html`)
  run in a sandboxed window in your browser; source files (C, C++, Rust, Go, Python,
  JavaScript, shell and more) run with "run on HOST" in a terminal on any host
  holding them that you've logged in to, built in a temp folder
- **editor**: edit text files live with others, saved as you type (ctrl+s saves now)
- **chat**: channels and direct messages; `/chimp` asks the AI model
- **status**: CPU, memory, disk and network for every host, and which AI model is in use
- **projects**: hand a longer task to the big AI model and watch it work; it runs on
  the model host, its files in a folder named after the project in `shared/projects/`
  of that host's home
- **git**: your own git server
- **games**: start and stop game servers, get the join address
- every other web service your hosts publish, with its own icon

Windows move, snap to edges and resize from any side. In the bar at the bottom:
your open windows, your hosts (purple is the one serving this page; click another
to switch), the mesh map, updates, and light or dark theme. Right click the desktop
to add a new file or upload files from your computer (or drop them on it), each
landing where you clicked, change the wallpaper or arrange the icons; right click a picture in files to make it
the wallpaper. Your wallpaper follows you to any browser.

## Updating

An admin clicks the update icon in the bottom bar (shown to admins only) and presses
update: every host updates, one at a time. Or run `phosphorus update` on a single host.

## Settings

Two files in `config/`, applied a few seconds after you save them.

`phosphorus.ini`, what this host does:

```
[files]
dir = files, /srv/media
priv = rwd, r

[home]
dir = files

[git]
host = true

[model]
host = true
gpu = true
url = https://huggingface.co/ggml-org/gpt-oss-120b-GGUF/resolve/main/gpt-oss-120b-MXFP4.gguf
```

- `[files]`: the folders to share, and for each `r` read, `w` write, `d` delete.
- `[home]`: which `[files]` dir gets `home/`, holding each user's folder, `shared/`
  (the orangutan's projects in `shared/projects/`) and `sys/` (users and settings),
  blank for `files/`. The rest of that dir stays an ordinary share, `home/` hidden
  from it. Change it (or press `h` on a dir in the files tab of `phos`) and `home/`
  moves there on the rebuild. `state/` is the host's own bookkeeping (chat cache, git, update and
  project records), never published.
- `[git]`: keep a copy of the git server on this host.
- `[model]`: make this the model host. It fetches `llama-server` and the opencode
  harness on its first start (and deletes them if it stops being the model host),
  runs the `.gguf` at `url` (needs memory about the model file's size), on an nvidia
  `gpu` if set, and answers every host's `/chimp` asks and runs every project.
  Without a `url` it still answers with a provider whose key you set in status.

Never share `/` or a home folder: shares have no login.

`services.export`, the web services and game servers on this host:

```
[grafana]
port = 3001

[terraria]
port = 7777
type = game
start = systemctl --user start tmodloader
stop = systemctl --user stop tmodloader
```

A service shows up at `yourdomain/host/name/`, or at `name.yourdomain` with
`mode = subdomain`. Both open in a desktop window: a subdomain service's
`X-Frame-Options` and `frame-ancestors` are relaxed to let your domain, and only it,
frame it. Game servers are reachable only inside the mesh, at `name.phosphorus`.

## Projects API

Through your domain logged in (the `phosphorus-user` cookie), or on the host itself;
JSON in and out, any host forwarding to the one named. Projects run on a model host:
a start without `host` goes to one.

| | |
|---|---|
| `GET /api/projects` | every host's projects |
| `POST /api/projects` | start one: `{host, title, brief, hours, by}` |
| `GET /api/projects/<host>/<id>` | one, with its tasks, notes and events |
| `GET /api/projects/<host>/<id>/events?since=<ms>` | the events after a time |
| `POST /api/projects/<host>/<id>/note` | `{text, by}`, read next round |
| `POST /api/projects/<host>/<id>/extend` | `{hours, by}` more for a running one |
| `POST /api/projects/<host>/<id>/restart` | `{hours, brief, by}`, back to work in the same folder |
| `POST /api/projects/<host>/<id>/stop` | `{by}` |
| `POST /api/projects/<host>/<id>/delete` | the record and its folder, once stopped |

## Command line

`phosphorus` (or `phos`) opens the same view in a terminal. `phosphorus start`,
`stop`, `restart` and `update` control this host.

## Development

One Go binary, `phosphorus`, is every role: `serve` (the frontend), `model` (the model
daemon), `elector` (the git host's election), `cli` and `ssh-relay`. No Node at build
or run time: `go generate ./internal/web` fetches the client's pinned npm tarballs
(checked against `web/vendor.lock`) and bundles `web/` with esbuild's Go API into the
binary.

```
cmd/phosphorus     the binary's entry, one subcommand per role
cmd/webbuild       the client's build, run by go generate
internal/          one package per part: server, mesh, sysfs, users, files, collab,
                   term, model, modeld, harness, project, tools, elector, cli, ...
web/               the client: index.html, style.css, src/ (apps/ each loaded on first open)
container/         the two images and their entry scripts
scripts/           install, start, update and the phosphorus launcher
test/dualrun       the JS and Go frontends side by side, every endpoint diffed
test/mesh          a mixed JS and Go mesh in network namespaces
legacy/            the JS frontend, kept until every host runs the binary
docs/formats.md    what phosphorus keeps on disk and on the wire
```

`make build`, `make check` (gofmt, vet, staticcheck), `make test` (race tests),
`make dualrun`, and `make mesh` (root).

## License

Copyright © 2026 Patrick Hartman. Apache License 2.0, see `LICENSE`.
Third-party licenses in `THIRD_PARTY_NOTICES.md`.
