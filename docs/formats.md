# What phosphorus keeps on disk and on the wire

Every format here is shared by the Go binary and the JS frontend in `legacy/`, byte
for byte where it matters, so a mesh can run both during an update. `test/dualrun`
and `test/mesh` hold them to it.

## The mesh's file system, `sys/`

`<[home] dir>/home/sys/`, out of every user's reach. `etc/` and `home/` are
replicated to every host, each file's newest write winning; `var/` is the host's own.

Each replicated file is one JSON object:

```
{"at": 1760000000000, "data": <any JSON>}     a value
{"at": 1760000000001, "gone": true}           a deletion
```

`at` is milliseconds since the epoch, at least one above the file's last stamp so
two writes in one millisecond still order. A path is `etc/` or `home/`, then
one to five segments of `[a-z0-9][a-z0-9._-]{0,63}`, ending `.json`. A peer's copy
wins when its `at` is greater; for an oldest-wins file (`etc/secret.json`) the
smaller `at` wins once one exists.

A host's digest: sha256 over every path sorted, each `path\tat\n` with `at` printed
as JavaScript prints a number, its first 32 hex characters. Equal digests mean equal
trees.

| Path | Holds |
|---|---|
| `etc/secret.json` | `{"v": hex}`, the mesh secret, oldest wins |
| `etc/passwd/<user>.json` | `{"admin": bool}` |
| `etc/shadow/<user>.json` | `{"salt": 32 hex, "hash": 64 hex, "pwAt": string}` |
| `etc/model/roles/<role>.json` | `{"model": "provider/model"}`, `mesh/<host>` for a host's own |
| `etc/model/keys/<provider>.json` | `{"key": string}` |
| `etc/chat/` | the chat channels |
| `etc/hosts/<host>/` | what each host publishes about itself |
| `etc/mirror/` | files kept on every host |
| `home/<user>/vault.json` | the user's vault, sealed (below) |
| `home/<user>/prefs.json` | icons, theme, recent files, chat colour |
| `home/<user>/wallpaper.json` | the wallpaper |
| `var/chat/own.json`, `var/chat/merged.json` | this host's chat and the mesh's, merged |

## Passwords, vaults and logins

- **Hash**: scrypt, N 16384, r 8, p 1, 64 bytes, salt 16 random bytes. The first 32
  bytes are the stored `hash`; the last 32 are the vault key, never stored.
- **Sealed box**: AES-256-GCM, 12 byte IV, `{"iv": hex, "tag": hex, "data": base64}`.
- **Vault**: the box of `{"hosts": {...}, "pages": {...}}` under the user's vault key.
- **Mesh key**: sha256 of `etc/secret.json`'s `v` string.
- **Login cookie** `phosphorus-user`: base64url, no padding, of
  `{"iv", "tag", "data", "h": issuing host}`, a box under the mesh key of
  `{"u": user, "p": pwAt, "k": hex vault key, "e": expiry ms}`, or `{"b": 1, "e"}` for
  the setup admin. A password change moves `pwAt`, ending every older login.

## A host's own `state/`

| File | Holds |
|---|---|
| `self-host` | this host's tailnet name |
| `model-claim.json` | the model daemon's claim: `host`, `ip`, `runs`, memory, and on the model host its file, `server` state, download and `tools` |
| `model-installed.json` | the `.gguf` it fetched, removed when the link changes |
| `machine.json`, `platform.json` | the machine's memory and OS, from the launcher |
| `reconfig.json` | `{"sig"}`: the `phosphorus.ini` values a rebuild last applied, JSON in the order dir, priv, home, git, gpu, model |
| `git-role`, `git-roster.json`, `git-elector-roster.json`, `git-claim.json`, `git-handoff.json`, `git-force-promote` | the git host's election |
| `update-chain.json`, `update-request.json`, `update-result.json`, `update-agent.json` | the mesh update |
| `project-runs/<id>.json` | one project's record: brief, tasks, notes, events |
| `chat-media/` | chat attachments |
| `net-day.json` | a day of network samples |
| `llama-slots/` | llama-server's saved slots |

## The model volume, `/models`

The `.gguf` named by `[model] url`, and `tools/` on the model host alone:
`llama-<tag>-<build>/` and `opencode-<tag>/`, each with a `.phosphorus-ok` stamp once
fully unpacked. Any other version or build there is deleted.

## Between hosts

Over the tailnet only, on the frontend's port (8090).

| Call | Answers |
|---|---|
| `GET /api/mesh/snapshot` | `self`, `sysDigest`, `chat`, `presence`, `git`, `model` (the claim), `projects`, `lock`, `chain` |
| `GET /api/sys/stamps` | every replicated path and its `at` |
| `GET /api/sys/sync?rels=a,b` | those files, or the whole tree |
| `POST /api/model/ask` | to a model host: `{messages, role, asker: "host\|id", direct}`, `{text, by}` back |
| `POST /api/model/asker` | to the asking host: `{id, op: name\|ui\|creds}`, the model host reaching the person asking |
| `GET /api/model/catalog?hop=1` | the model host's provider catalog |
| `POST /api/model/v1/chat/completions` | a mesh model, OpenAI's shape, passed to the host running it |
| `POST /api/projects?hop=1` | a project started on the host named |
| `/api/git/view`, `/api/git/vote`, `/api/git/promote` | the git election |
| `/api/update/local`, `/api/update/local/status` | one host's step of a mesh update |

## Collaborative editing

Operations as `collab.js` speaks them: a list of retains (positive numbers),
inserts (strings) and deletes (negative numbers), positions in UTF-16 code units.
