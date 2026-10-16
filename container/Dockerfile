# syntax=docker/dockerfile:1
# every image off one Go build: phosphorus (default, last), --target model
# (phosphorus-model) and --target git (phosphorus-git)

# --- the binary ----------------------------------------------------------------
# server, model daemon, elector, cli and the client's bundle in one static file,
# the client built from pinned npm tarballs by go generate, no node anywhere
FROM golang:1.26-trixie AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY web/ web/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/src/web/.vendor \
    go generate ./internal/web \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/phosphorus ./cmd/phosphorus

# --- shared base -----------------------------------------------------------------
FROM debian:trixie-slim AS base
# inherited by every container off these images, for sweep.sh
LABEL org.phosphorus=phosphorus

# --- phosphorus-model: llama-server and opencode on the model host ---------------
# both fetched into /models at run time, libgomp for llama-server; git, ripgrep
# and the docker cli for opencode's tools and the projects' sandboxes
FROM base AS model
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl procps libgomp1 bash git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*'
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /out/phosphorus /usr/local/bin/phosphorus
ENTRYPOINT ["/usr/local/bin/phosphorus", "model"]

# --- phosphorus-git: forgejo, its db rsynced as snapshots, its elector the binary --
FROM base AS git
LABEL org.phosphorus=git
ARG FORGEJO_VERSION=16.0.5
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq bash git rsync openssh-client sqlite3 \
    && rm -rf /var/lib/apt/lists/*
# forgejo refusing root, ids matching the data already on disk
RUN groupadd -g 4000 phosphorus \
 && useradd -u 4001 -g phosphorus -d /var/lib/phosphorus/git -s /usr/sbin/nologin git
RUN curl -fsSL -o /usr/local/bin/forgejo "https://codeberg.org/forgejo/forgejo/releases/download/v${FORGEJO_VERSION}/forgejo-${FORGEJO_VERSION}-linux-${TARGETARCH:-amd64}" \
 && chmod 755 /usr/local/bin/forgejo
COPY container/git/app.ini.tmpl    /etc/forgejo/app.ini.tmpl
COPY container/git/rsyncd.conf     /etc/rsyncd.conf
COPY --chmod=755 container/git/git-daemon.sh /usr/local/bin/git-daemon.sh
COPY --from=build /out/phosphorus  /usr/local/bin/phosphorus
RUN mkdir -p /var/lib/phosphorus/git
ENTRYPOINT ["/usr/local/bin/git-daemon.sh"]

# --- phosphorus: tailscale, the frontend and the tunnel ---------------------------
FROM base
# iproute2/iptables for tailscaled's routing
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq bash procps iproute2 iptables git openssh-client \
    && rm -rf /var/lib/apt/lists/*

# cloudflared, the docker cli for the host's daemon via the socket, tailscale;
# safe.directory: bind-mounted repos aren't root's
RUN K=/usr/share/keyrings L=/etc/apt/sources.list.d \
 && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o $K/cloudflare.gpg \
 && echo "deb [signed-by=$K/cloudflare.gpg] https://pkg.cloudflare.com/cloudflared any main" > $L/cloudflared.list \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o $K/docker.asc \
 && echo "deb [signed-by=$K/docker.asc] https://download.docker.com/linux/debian trixie stable" > $L/docker.list \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg -o $K/tailscale.gpg \
 && echo "deb [signed-by=$K/tailscale.gpg] https://pkgs.tailscale.com/stable/debian trixie main" > $L/tailscale.list \
 && apt-get update && apt-get install -y --no-install-recommends \
        cloudflared docker-ce-cli docker-compose-plugin docker-buildx-plugin tailscale \
 && rm -rf /var/lib/apt/lists/* $L/cloudflared.list $L/docker.list $L/tailscale.list $K/cloudflare.gpg $K/docker.asc $K/tailscale.gpg \
 && git config --system --add safe.directory '*' \
 && mkdir -p /var/lib/tailscale /var/run/tailscale

# last, so commits touching them rebuild only these cheap layers
COPY --chmod=755 container/phosphorus/supervisor.sh /usr/local/bin/supervisor.sh
COPY container/phosphorus/sweep.sh /opt/phosphorus/sweep.sh
COPY --from=build /out/phosphorus /usr/local/bin/phosphorus
# the release version, stamped by CI
ARG PHOSPHORUS_VERSION=0.0.0
RUN echo "$PHOSPHORUS_VERSION" > /opt/phosphorus/VERSION
ENTRYPOINT ["/usr/local/bin/supervisor.sh"]
