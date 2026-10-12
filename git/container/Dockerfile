FROM debian:trixie-slim
# inherited by every container off this image, for container/sweep.sh
LABEL org.hesperus=git

ARG LITEFS_VERSION=v0.5.14
ARG FORGEJO_VERSION=16.0.5
# set by buildkit (amd64|arm64), empty under the legacy builder
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq bash git rsync openssh-client fuse3 nodejs \
    && echo user_allow_other >> /etc/fuse.conf \
    && rm -rf /var/lib/apt/lists/*

# forgejo refusing root, ids matching what the old hesperus-git container wrote
RUN groupadd -g 4000 hesperus \
 && useradd -u 4001 -g hesperus -d /var/lib/hesperus/git -s /usr/sbin/nologin git

# --- litefs ------------------------------------------------------------
RUN curl -fsSL "https://github.com/superfly/litefs/releases/download/${LITEFS_VERSION}/litefs-${LITEFS_VERSION}-linux-${TARGETARCH:-amd64}.tar.gz" \
      -o /tmp/litefs.tar.gz \
 && tar -xzf /tmp/litefs.tar.gz -C /usr/local/bin litefs \
 && rm /tmp/litefs.tar.gz \
 && chmod +x /usr/local/bin/litefs

# --- forgejo -------------------------------------------------------------
RUN curl -fsSL "https://codeberg.org/forgejo/forgejo/releases/download/v${FORGEJO_VERSION}/forgejo-${FORGEJO_VERSION}-linux-${TARGETARCH:-amd64}" \
      -o /usr/local/bin/forgejo \
 && chmod 755 /usr/local/bin/forgejo

# --- our own files ---------------------------------------------------------
COPY git/container/litefs.yml.tmpl /etc/litefs/litefs.yml.tmpl
COPY git/container/app.ini.tmpl    /etc/forgejo/app.ini.tmpl
COPY git/container/rsyncd.conf     /etc/rsyncd.conf
COPY git/container/git-daemon.sh   /usr/local/bin/git-daemon.sh
COPY git/container/elector.js      /usr/local/lib/hesperus-git/elector.js
RUN chmod +x /usr/local/bin/git-daemon.sh \
 && mkdir -p /var/lib/hesperus/git /var/lib/litefs-internal

ENTRYPOINT ["/usr/local/bin/git-daemon.sh"]
