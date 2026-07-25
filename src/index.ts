#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, registerCapabilities } from "./server.js";
import { createTransportFromEnv } from "./transport/index.js";
import { BridgeClient } from "./transport/bridge.js";
import { communityToolListing } from "./list-tools.js";

async function main(): Promise<void> {
  const pidgeonTransport = createTransportFromEnv();
  const mode = pidgeonTransport.getMode();
  const bridgeUrl = process.env["PIDGEON_BRIDGE_URL"] ?? "http://localhost:5100";

  // Check transport availability. Log everything to stderr — stdout is the MCP protocol wire.
  const available = await pidgeonTransport.isAvailable();

  if (!available) {
    if (mode === "bridge") {
      process.stderr.write(
        `[pidgeon-mcp] Bridge not reachable at ${bridgeUrl}. ` +
          `Start a Pidgeon desktop app (Post, Flock, Loft, or Migrate) to run the Bridge, ` +
          `or set PIDGEON_MODE=cli to use the pidgeon CLI directly.\n`
      );
    } else {
      process.stderr.write(
        `[pidgeon-mcp] CLI not found at '${process.env["PIDGEON_CLI_PATH"] ?? "pidgeon"}'. ` +
          `Install with: dotnet tool install --global Pidgeon.CLI --version 0.1.0-beta.1\n`
      );
    }
    process.stderr.write(
      "[pidgeon-mcp] Starting anyway — tools will return setup instructions on failure. " +
        "Call the pidgeon_status tool for diagnostics.\n"
    );
  } else if (mode === "bridge" && pidgeonTransport instanceof BridgeClient) {
    // Bridge is up — check auth and surface tier info so the user knows what's available.
    const profile = await pidgeonTransport.getAuthProfile();

    if (!profile.isAuthenticated) {
      process.stderr.write(
        "[pidgeon-mcp] Bridge connected but not authenticated. " +
          "Run 'pidgeon auth login' to enable Pro features. " +
          "Free-tier tools will still work.\n"
      );
    } else {
      const tier = profile.tier ?? "free";
      const identity = profile.profile?.email ?? profile.profile?.username ?? "authenticated user";

      if (tier === "free") {
        process.stderr.write(
          `[pidgeon-mcp] Authenticated as ${identity} (Free). ` +
            `Some tools require Pro — upgrade at pidgeon.health/upgrade\n`
        );
      } else {
        process.stderr.write(
          `[pidgeon-mcp] Authenticated as ${identity} (${tier}). All tools enabled.\n`
        );
      }
    }
  } else {
    process.stderr.write(`[pidgeon-mcp] Connected (mode: ${mode}). Tools ready.\n`);
  }

  const server = createServer();
  // Registration resolves the composition roster (community allowlist in CLI
  // mode, the server-advertised entitled set in Bridge mode) before the stdio
  // transport connects, so the first tools/list a client sees is the real roster.
  await registerCapabilities(server, pidgeonTransport);

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
}

if (process.argv.slice(2).includes("--list-tools")) {
  process.stdout.write(`${JSON.stringify(communityToolListing(), null, 2)}\n`);
} else {
  main().catch((err) => {
    process.stderr.write(`[pidgeon-mcp] Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
