# Third-party notices

phosphorus ships no third-party source in this repository. Its Dockerfiles
build two images on each host, and those builds download the components below
from their upstream publishers, unmodified. Each stays under its own license;
the phosphorus license (see `LICENSE`) covers none of them.

## phosphorus image (`container/Dockerfile`)

| Component | License | Source |
|---|---|---|
| Debian trixie-slim (base image) | Various, per package (DFSG) | https://www.debian.org |
| cloudflared | Apache-2.0 | https://github.com/cloudflare/cloudflared |
| Docker CLI (`docker-ce-cli`) | Apache-2.0 | https://github.com/docker/cli |
| Docker Compose (`docker-compose-plugin`) | Apache-2.0 | https://github.com/docker/compose |
| Docker Buildx (`docker-buildx-plugin`) | Apache-2.0 | https://github.com/docker/buildx |
| Tailscale | BSD-3-Clause | https://github.com/tailscale/tailscale |
| llama.cpp (`llama-server`) | MIT | https://github.com/ggml-org/llama.cpp |
| opencode (the model harness) | MIT | https://github.com/anomalyco/opencode |
| ripgrep (opencode's grep and glob) | MIT OR Unlicense | https://github.com/BurntSushi/ripgrep |
| NVIDIA CUDA runtime (only with `[model] gpu`) | NVIDIA CUDA EULA | https://developer.nvidia.com/cuda-toolkit |
| Node.js | MIT | https://github.com/nodejs/node |
| ws (frontend) | MIT | https://github.com/websockets/ws |
| ssh2 (frontend) | MIT | https://github.com/mscdex/ssh2 |
| asn1, safer-buffer (ssh2) | MIT | https://www.npmjs.com/package/asn1 |
| bcrypt-pbkdf (ssh2) | BSD-3-Clause | https://github.com/joyent/node-bcrypt-pbkdf |
| tweetnacl (ssh2) | Unlicense | https://github.com/dchest/tweetnacl-js |
| xterm.js, xterm fit addon (frontend) | MIT | https://github.com/xtermjs/xterm.js |
| marked (frontend, chat markdown) | MIT | https://github.com/markedjs/marked |
| DOMPurify (frontend, chat markdown) | MPL-2.0 OR Apache-2.0 | https://github.com/cure53/DOMPurify |
| KaTeX and its fonts (frontend, chat math) | MIT | https://github.com/KaTeX/KaTeX |
| Geist Mono (frontend, the page's font, via @fontsource-variable/geist-mono) | OFL-1.1 | https://github.com/vercel/geist-font |
| commander (KaTeX) | MIT | https://github.com/tj/commander.js |

## phosphorus-git image (`container/git/Dockerfile`)

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
| gnupg | GPL-3.0-or-later |
| iproute2 | GPL-2.0-or-later |
| iptables | GPL-2.0-or-later |
| jq | MIT |
| openssh-client | BSD-style (OpenSSH) |
| procps | GPL-2.0-or-later, LGPL-2.0-or-later |
| rsync | GPL-3.0-or-later |

Full license texts for installed Debian packages are in each image under
`/usr/share/doc/<package>/copyright`. The build-only `npm` package is purged
before the image is finalized.

## Trademarks

Cloudflare, Docker, Forgejo, Node.js and Tailscale are trademarks of
their respective owners. phosphorus is not affiliated with or endorsed by any
of them.
