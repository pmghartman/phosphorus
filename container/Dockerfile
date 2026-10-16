# --- the binary -----------------------------------------------------------------
# server, model daemon, cli and the client's bundle in one static file, built
# from pinned npm tarballs by go generate, no node anywhere; two images off it:
# phosphorus (the default, last) and model (--target model, phosphorus-model)
FROM golang:1.26-trixie AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY web/ web/
RUN go generate ./internal/web \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/phosphorus ./cmd/phosphorus

# --- phosphorus-model: llama-server on the model host -------------------------
# llama-server and opencode fetched into /models at run time, libgomp for the
# first, no tailscale, tunnel or docker of its own
FROM debian:trixie-slim AS model
LABEL org.phosphorus=phosphorus
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl procps libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/phosphorus /usr/local/bin/phosphorus
ARG PHOSPHORUS_VERSION=0.0.0
RUN mkdir -p /opt/phosphorus && echo "$PHOSPHORUS_VERSION" > /opt/phosphorus/VERSION
ENTRYPOINT ["/usr/local/bin/phosphorus", "model"]

# --- phosphorus ----------------------------------------------------------------
FROM debian:trixie-slim
# inherited by every container off this image, for sweep.sh
LABEL org.phosphorus=phosphorus

# iproute2/iptables for tailscaled's routing, ripgrep for opencode, run by the
# model host's frontend off the binary phosphorus-model fetched
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq bash procps iproute2 iptables git openssh-client \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# --- cloudflared, docker cli, tailscale ------------------------------------
# three vendor repos, one index fetch, docker CLI only for the host's daemon
# via the socket, safe.directory: bind-mounted repos aren't root's; the repos
# and their keys gone with the layer, docker's armored key read by apt as is
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
 && git config --system --add safe.directory '*'

# --- our own files ------------------------------------------------------------
# last, so commits touching them rebuild only these cheap layers
COPY container/sweep.sh            /opt/phosphorus/sweep.sh
COPY container/supervisor.sh       /usr/local/bin/supervisor.sh
COPY --from=build /out/phosphorus  /usr/local/bin/phosphorus
# the release version, stamped by CI
ARG PHOSPHORUS_VERSION=0.0.0
RUN echo "$PHOSPHORUS_VERSION" > /opt/phosphorus/VERSION \
 && chmod +x /usr/local/bin/supervisor.sh \
 && mkdir -p /var/lib/tailscale /var/run/tailscale

ENTRYPOINT ["/usr/local/bin/supervisor.sh"]
