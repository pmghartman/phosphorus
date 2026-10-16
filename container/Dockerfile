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

# --- phosphorus-model: llama-server on the model host ---------------------------
# llama-server and opencode fetched into /models at run time, libgomp for the first
FROM base AS model
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl procps libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/phosphorus /usr/local/bin/phosphorus
ENTRYPOINT ["/usr/local/bin/phosphorus", "model"]

# --- phosphorus-git: forgejo on litefs, its elector the binary --------------------
FROM base AS git
LABEL org.phosphorus=git
ARG LITEFS_VERSION=v0.5.14
ARG FORGEJO_VERSION=16.0.5
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq bash git rsync openssh-client fuse3 \
    && echo user_allow_other >> /etc/fuse.conf \
    && rm -rf /var/lib/apt/lists/*
# forgejo refusing root, ids matching the data already on disk
RUN groupadd -g 4000 phosphorus \
 && useradd -u 4001 -g phosphorus -d /var/lib/phosphorus/git -s /usr/sbin/nologin git
RUN curl -fsSL "https://github.com/superfly/litefs/releases/download/${LITEFS_VERSION}/litefs-${LITEFS_VERSION}-linux-${TARGETARCH:-amd64}.tar.gz" \
      | tar -xz -C /usr/local/bin litefs \
 && curl -fsSL -o /usr/local/bin/forgejo "https://codeberg.org/forgejo/forgejo/releases/download/v${FORGEJO_VERSION}/forgejo-${FORGEJO_VERSION}-linux-${TARGETARCH:-amd64}" \
 && chmod 755 /usr/local/bin/litefs /usr/local/bin/forgejo
COPY container/git/litefs.yml.tmpl /etc/litefs/litefs.yml.tmpl
COPY container/git/app.ini.tmpl    /etc/forgejo/app.ini.tmpl
COPY container/git/rsyncd.conf     /etc/rsyncd.conf
COPY --chmod=755 container/git/git-daemon.sh /usr/local/bin/git-daemon.sh
COPY --from=build /out/phosphorus  /usr/local/bin/phosphorus
RUN mkdir -p /var/lib/phosphorus/git /var/lib/litefs-internal
ENTRYPOINT ["/usr/local/bin/git-daemon.sh"]

# --- phosphorus: tailscale, the frontend and the tunnel ---------------------------
FROM base
# iproute2/iptables for tailscaled's routing, ripgrep for opencode
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq bash procps iproute2 iptables git openssh-client ripgrep \
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
