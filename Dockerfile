# The relay, and only the relay — the CLI stays on the host's laptop.
# Pure-JS deps (ssh2, ws, xterm assets), no native builds: slim base is enough.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Workspace manifests first (layer caching): npm ci -w needs every workspace's
# package.json present to verify the lockfile, but installs only the relay's deps.
COPY package.json package-lock.json ./
COPY packages/relay/package.json packages/relay/
COPY packages/shared/package.json packages/shared/
COPY packages/cli/package.json packages/cli/
# --ignore-scripts: the root manifest lists node-pty (a native module, for the
# published CLI) — the relay never imports it, and slim has no toolchain to
# build it. Skipping install scripts keeps this image pure-JS.
RUN npm ci --omit=dev --workspace=packages/relay --ignore-scripts

# The relay imports ../shared/protocol.js relatively — ship both packages.
COPY packages/relay packages/relay
COPY packages/shared packages/shared

EXPOSE 8080 2222
CMD ["node", "packages/relay/bin/serve.js"]
