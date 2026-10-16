# Third-party notices

phosphorus ships no third-party source in this repository. The `phosphorus`
binary statically links the Go modules below, its embedded web client bundles
the npm packages below, and the image builds download the rest from their
upstream publishers, unmodified. Each stays under its own license; the
phosphorus license (see `LICENSE`) covers none of them.

## The `phosphorus` binary

| Component | License | Source |
|---|---|---|
| Go standard library and runtime | BSD-3-Clause | https://go.dev |
| golang.org/x/crypto, net, sync, sys, term, text | BSD-3-Clause | https://go.googlesource.com |
| coder/websocket | ISC | https://github.com/coder/websocket |
| goldmark (chat markdown) | MIT | https://github.com/yuin/goldmark |
| chroma (code highlighting) | MIT | https://github.com/alecthomas/chroma |
| dlclark/regexp2 (chroma) | MIT | https://github.com/dlclark/regexp2 |
| bluemonday (html sanitizing) | BSD-3-Clause | https://github.com/microcosm-cc/bluemonday |
| aymerick/douceur, gorilla/css (bluemonday) | MIT, BSD-3-Clause | https://github.com/aymerick/douceur, https://github.com/gorilla/css |
| charmbracelet x/vt, ultraviolet, x/ansi, x/term, x/termios, x/windows, x/exp/ordered, colorprofile (terminal screens) | MIT | https://github.com/charmbracelet |
| clipperhouse displaywidth, uax29 | MIT | https://github.com/clipperhouse |
| mattn/go-runewidth, rivo/uniseg, lucasb-eyer/go-colorful, muesli/cancelreader, xo/terminfo | MIT | GitHub, under each name |
| andybalholm/brotli | MIT | https://github.com/andybalholm/brotli |

Built with esbuild (MIT, https://github.com/evanw/esbuild), which bundles the
client at build time and is not part of the binary.

## The web client, embedded in the binary

| Component | License | Source |
|---|---|---|
| xterm.js, its fit and webgl addons | MIT | https://github.com/xtermjs/xterm.js |
| KaTeX and its fonts (chat math) | MIT | https://github.com/KaTeX/KaTeX |
| Mermaid (diagrams), with the libraries its bundle carries, among them D3 (ISC), DOMPurify (MPL-2.0 OR Apache-2.0), cytoscape, dagre and lodash (MIT) | MIT | https://github.com/mermaid-js/mermaid |
| Lezer and its grammars (editor checks and highlighting) | MIT | https://github.com/lezer-parser |
| Geist Mono (the page's font, via @fontsource-variable/geist-mono) | OFL-1.1 | https://github.com/vercel/geist-font |

## phosphorus image (`container/Dockerfile`)

| Component | License | Source |
|---|---|---|
| Debian trixie-slim (base image) | Various, per package (DFSG) | https://www.debian.org |
| cloudflared | Apache-2.0 | https://github.com/cloudflare/cloudflared |
| Docker CLI (`docker-ce-cli`) | Apache-2.0 | https://github.com/docker/cli |
| Docker Compose (`docker-compose-plugin`) | Apache-2.0 | https://github.com/docker/compose |
| Docker Buildx (`docker-buildx-plugin`) | Apache-2.0 | https://github.com/docker/buildx |
| Tailscale | BSD-3-Clause | https://github.com/tailscale/tailscale |
| ripgrep (opencode's grep and glob) | MIT OR Unlicense | https://github.com/BurntSushi/ripgrep |

## Fetched at run time by the model host alone

The host with `[model] host = true` downloads these into its model folder on
first start, and deletes them when it stops being the model host.

| Component | License | Source |
|---|---|---|
| llama.cpp (`llama-server`) | MIT | https://github.com/ggml-org/llama.cpp |
| opencode (the model harness) | MIT | https://github.com/anomalyco/opencode |
| NVIDIA CUDA runtime (only with `[model] gpu`, on x86-64) | NVIDIA CUDA EULA | https://developer.nvidia.com/cuda-toolkit |

## phosphorus-git image (`container/Dockerfile --target git`)

| Component | Version | License | Source |
|---|---|---|---|
| Forgejo | 16.0.5 | GPL-3.0-or-later | https://codeberg.org/forgejo/forgejo |
| LiteFS | 0.5.14 | Apache-2.0 | https://github.com/superfly/litefs |

Forgejo is run as a separate, unmodified program; phosphorus only writes its
configuration. Its source is available at the link above.

## Debian packages (both images)

| Package | License |
|---|---|
| bash | GPL-3.0-or-later |
| ca-certificates | MPL-2.0 |
| curl | curl |
| fuse3 | GPL-2.0 (tools), LGPL-2.1 (library) |
| git | GPL-2.0-only |
| iproute2 | GPL-2.0-or-later |
| iptables | GPL-2.0-or-later |
| jq | MIT |
| libgomp1 | GPL-3.0-or-later with the GCC Runtime Library Exception |
| openssh-client | BSD-style (OpenSSH) |
| procps | GPL-2.0-or-later, LGPL-2.0-or-later |
| rsync | GPL-3.0-or-later |

Full license texts for installed Debian packages are in each image under
`/usr/share/doc/<package>/copyright`.

## Trademarks

Cloudflare, Docker, Forgejo and Tailscale are trademarks of their respective
owners. phosphorus is not affiliated with or endorsed by any of them.
