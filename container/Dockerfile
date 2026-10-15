# --- the binary -----------------------------------------------------------------
# server, model daemon, cli and the client's bundle in one static file, built
# from pinned npm tarballs by go generate, no node anywhere
FROM golang:1.26-trixie AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
COPY web/ web/
RUN go generate ./internal/web \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/phosphorus ./cmd/phosphorus

FROM debian:trixie-slim
# inherited by every container off this image, for sweep.sh
LABEL org.phosphorus=phosphorus

# shared by everything below, iproute2/iptables for tailscaled's routing,
# libgomp for llama-server and ripgrep for opencode, both fetched by the
# model host alone at run time
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq bash procps iproute2 iptables git openssh-client \
        libgomp1 ripgrep \
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
COPY container/node-shim.sh        /usr/local/bin/node
COPY --from=build /out/phosphorus  /usr/local/bin/phosphorus
# the release version, stamped by CI
ARG PHOSPHORUS_VERSION=0.0.0
RUN echo "$PHOSPHORUS_VERSION" > /opt/phosphorus/VERSION \
 && chmod +x /usr/local/bin/supervisor.sh /usr/local/bin/node \
 && mkdir -p /var/lib/tailscale /var/run/tailscale

ENTRYPOINT ["/usr/local/bin/supervisor.sh"]
