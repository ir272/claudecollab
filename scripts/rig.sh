#!/bin/sh
# dev rig for UI screenshots: relay on 2226 (ssh) / 8788 (web), host wrapping the fake claude
cd "$(dirname "$0")/.."
node -e '
  import("./packages/relay/server.js").then(async ({ startRelay }) => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const keyPath = os.homedir() + "/.claude-share-dev-hostkey";
    const relay = await startRelay({ port: 2226, webPort: 8788, hostName: "dev", hostKeyPath: keyPath });
    console.log("relay up: ssh", relay.port, "web", relay.webPort);
  });
' &
RELAY_PID=$!
sleep 1
mkdir -p /tmp/cs-rig-shim
printf '#!/bin/sh\nexec %s %s "$@"\n' "$(command -v node)" "$(pwd)/test/fixtures/fake-claude.cjs" > /tmp/cs-rig-shim/claude
chmod +x /tmp/cs-rig-shim/claude
export PATH="/tmp/cs-rig-shim:$PATH"
export CLAUDE_SHARE_NO_CLIPBOARD=1
node packages/cli/bin/claude-share.js --relay ssh://127.0.0.1:2226 --web-port 8788
kill $RELAY_PID 2>/dev/null
