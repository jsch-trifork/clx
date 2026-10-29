# Image for docker workspaces (clx -w NAME --docker). Claude Code runs here as your
# user, with only the workspace folders mounted. Build your own toolchain image
# FROM this one and set "image" on the workspace.
# Pinned by digest, so a changed upstream image can't slip in unnoticed.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da
ARG CLAUDE_VERSION=stable
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git ripgrep jq less procps python3 make \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
 && npm cache clean --force \
 # Strip setuid/setgid bits (mount, su, passwd, …): the session never needs them,
 # and no-new-privileges already neutralises them, so this is defence in depth.
 && find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod -s {} + 2>/dev/null || true
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    ENABLE_CLAUDEAI_MCP_SERVERS=false
