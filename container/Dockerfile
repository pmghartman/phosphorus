FROM debian:trixie-slim
# inherited by every container off this image, for sweep.sh
LABEL org.hesperus=hesperus

# shared by everything below, iproute2/iptables for tailscaled's routing
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq gnupg bash procps iproute2 iptables git \
    && rm -rf /var/lib/apt/lists/*

# --- cloudflared, docker cli, tailscale ------------------------------------
# three vendor repos, one index fetch, docker CLI only for the host's daemon
# via the socket, safe.directory: the bind-mounted checkout isn't root's
RUN K=/usr/share/keyrings L=/etc/apt/sources.list.d \
 && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o $K/cloudflare.gpg \
 && echo "deb [signed-by=$K/cloudflare.gpg] https://pkg.cloudflare.com/cloudflared any main" > $L/cloudflared.list \
 && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o $K/docker.gpg \
 && echo "deb [signed-by=$K/docker.gpg] https://download.docker.com/linux/debian trixie stable" > $L/docker.list \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg -o $K/tailscale.gpg \
 && echo "deb [signed-by=$K/tailscale.gpg] https://pkgs.tailscale.com/stable/debian trixie main" > $L/tailscale.list \
 && apt-get update && apt-get install -y --no-install-recommends \
        cloudflared docker-ce-cli docker-compose-plugin docker-buildx-plugin tailscale \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'

# --- llama.cpp ----------------------------------------------------------------
# upstream's release build of llama-server, cuda only where rebuild
# asks for it ([model] gpu), its runtime libs beside the binaries
ARG LLAMA_TAG=b11284
ARG LLAMA_BACKEND=cpu
RUN arch="$(dpkg --print-architecture | sed 's/amd64/x64/')" kind="" \
 && base="https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG" \
 && if [ "$LLAMA_BACKEND" = cuda ] && [ "$arch" = x64 ]; then kind="cuda-12.8-x64"; else kind="$arch"; fi \
 && apt-get update && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/llama \
 && curl -fsSL "$base/llama-$LLAMA_TAG-bin-ubuntu-$kind.tar.gz" | tar xz -C /opt/llama --strip-components=1 \
 && if [ "$kind" != "$arch" ]; then \
      curl -fsSL "$base/cudart-llama-$LLAMA_TAG-bin-ubuntu-$kind.tar.gz" | tar xz -C /opt/llama --strip-components=1; \
    fi \
 && [ -x /opt/llama/llama-server ]

# --- opencode -----------------------------------------------------------------
# upstream's release build, hesperus's harness run headless by the frontend,
# ripgrep for its grep and glob so it never fetches one
ARG OPENCODE_TAG=v1.18.34
RUN arch="$(dpkg --print-architecture | sed 's/amd64/x64-baseline/')" \
 && apt-get update && apt-get install -y --no-install-recommends ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/opencode \
 && curl -fsSL "https://github.com/anomalyco/opencode/releases/download/$OPENCODE_TAG/opencode-linux-$arch.tar.gz" | tar xz -C /opt/opencode \
 && [ -x /opt/opencode/opencode ]

# --- frontend ----------------------------------------------------------------
# npm purged in this same RUN, or the layer still ships it, ssh2 as pure
# JS: no native builds, no install scripts, mermaid (a dev dependency) its
# self-contained browser bundle alone, not its 180MB tree
COPY frontend/package.json frontend/package-lock.json /opt/frontend/
RUN apt-get update && apt-get install -y --no-install-recommends \
        nodejs npm openssh-client \
    && cd /opt/frontend && npm ci --omit=dev --omit=optional --ignore-scripts \
    && npm pack --silent "mermaid@$(node -p 'require("./package.json").devDependencies.mermaid')" \
    && mkdir -p node_modules/mermaid && tar -xzf mermaid-*.tgz -C node_modules/mermaid --strip-components=1 package/dist/mermaid.min.js \
    && rm mermaid-*.tgz && [ -s node_modules/mermaid/dist/mermaid.min.js ] \
    && apt-get purge -y npm && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# --- our own files ------------------------------------------------------------
# last, so commits touching them rebuild only these cheap layers
COPY container/sweep.sh            /opt/hesperus/sweep.sh
COPY container/model.js            /opt/hesperus/model.js
COPY container/supervisor.sh       /usr/local/bin/supervisor.sh
COPY frontend/                     /opt/frontend/
# stamped by rebuild: VERSION's <major>.<minor> and the commit count
ARG HESPERUS_VERSION=0.0.0
RUN echo "$HESPERUS_VERSION" > /opt/hesperus/VERSION \
 && chmod +x /usr/local/bin/supervisor.sh \
 && mkdir -p /var/lib/tailscale /var/run/tailscale

ENTRYPOINT ["/usr/local/bin/supervisor.sh"]
