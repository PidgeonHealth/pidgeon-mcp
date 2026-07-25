// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { ToolDefinition } from "./types.js";
import { PidgeonTransport } from "../transport/types.js";

const execFileAsync = promisify(execFile);

interface StatusCheck {
  component: string;
  status: "ok" | "missing" | "error" | "degraded";
  detail: string;
  action?: string;
}

async function checkDotnet(): Promise<StatusCheck> {
  try {
    const { stdout } = await execFileAsync("dotnet", ["--version"], { timeout: 5000 });
    return {
      component: ".NET SDK",
      status: "ok",
      detail: `.NET SDK ${stdout.trim()} installed`,
    };
  } catch {
    return {
      component: ".NET SDK",
      status: "missing",
      detail: ".NET SDK not found on PATH",
      action: "Install .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0",
    };
  }
}

async function checkCli(cliPath: string): Promise<StatusCheck> {
  try {
    const { stdout } = await execFileAsync(cliPath, ["--version"], { timeout: 5000 });
    return {
      component: "Pidgeon CLI",
      status: "ok",
      detail: `Pidgeon CLI ${stdout.trim()} at '${cliPath}'`,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        component: "Pidgeon CLI",
        status: "missing",
        detail: `Pidgeon CLI not found at '${cliPath}'`,
        action: "Install: dotnet tool install --global Pidgeon.CLI --version 0.1.0-beta.1",
      };
    }
    return {
      component: "Pidgeon CLI",
      status: "error",
      detail: `Pidgeon CLI error: ${e.message}`,
      action: "Try reinstalling: dotnet tool install --global Pidgeon.CLI --version 0.1.0-beta.1",
    };
  }
}

interface OnDeviceModelStatus {
  name: string;
  tag: string;
  servedContextWindow: number;
}

// The served context window (num_ctx) each bundled on-device model is actually
// run against — so an agent can see what it is running against, not the model
// card's theoretical maximum (H-36). Reads the Bridge catalog, whose ModelMetadata
// now carries the served window; degrades silently if the Bridge is unreachable.
async function fetchOnDeviceModels(baseUrl: string): Promise<OnDeviceModelStatus[]> {
  try {
    const axios = (await import("axios")).default;
    const response = await axios.get(`${baseUrl}/api/ai/models/catalog`, { timeout: 3000 });
    const models = response.data?.data?.models;
    if (!Array.isArray(models)) return [];
    return models
      .filter(
        (m) =>
          typeof m?.servedContextWindowTokens === "number" &&
          m.servedContextWindowTokens > 0
      )
      .map((m) => ({
        name: m.name ?? m.id ?? "unknown",
        tag: m.ollamaTag ?? "",
        servedContextWindow: m.servedContextWindowTokens,
      }));
  } catch {
    return [];
  }
}

async function checkBridge(baseUrl: string): Promise<StatusCheck> {
  try {
    const axios = (await import("axios")).default;
    const response = await axios.get(`${baseUrl}/api/health`, { timeout: 3000 });
    const version = response.data?.version ?? "unknown";
    return {
      component: "Pidgeon Bridge",
      status: "ok",
      detail: `Bridge running at ${baseUrl} (v${version})`,
    };
  } catch {
    return {
      component: "Pidgeon Bridge",
      status: "missing",
      detail: `Bridge not reachable at ${baseUrl}`,
      action:
        "Start a Pidgeon desktop app (Post, Flock, Loft, or Migrate) — it runs the Bridge.\n" +
        "  Or set PIDGEON_MODE=cli to use the CLI directly (fewer features).",
    };
  }
}

export function createStatusTool(): ToolDefinition {
  return {
    name: "pidgeon_status",
    description:
      "Check Pidgeon environment health: CLI installation, Bridge connectivity, " +
      ".NET SDK, current mode, and tier. Returns actionable setup instructions for " +
      "any missing components. Call this when other tools fail or at conversation start.",
    requiredTier: "free" as const,
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: z.object({}),
    handler: async (
      transport: PidgeonTransport,
      _args: Record<string, unknown>
    ) => {
      const mode = transport.getMode();
      const cliPath = process.env["PIDGEON_CLI_PATH"] ?? "pidgeon";
      const bridgeUrl = process.env["PIDGEON_BRIDGE_URL"] ?? "http://localhost:5100";

      const checks: StatusCheck[] = [];

      // Always check .NET and CLI
      checks.push(await checkDotnet());
      checks.push(await checkCli(cliPath));

      // Check Bridge if in bridge mode
      if (mode === "bridge") {
        checks.push(await checkBridge(bridgeUrl));
      }

      // Check tier
      let tier = "free";
      try {
        tier = await transport.getTier();
      } catch {
        // tier stays free
      }

      // On-device model served windows (bridge mode only; empty if unreachable).
      const onDeviceModels =
        mode === "bridge" ? await fetchOnDeviceModels(bridgeUrl) : [];

      // Build output
      const lines: string[] = [];
      lines.push("## Pidgeon Environment Status\n");
      lines.push(`**Mode**: ${mode}`);
      lines.push(`**Tier**: ${tier}`);
      lines.push("");

      let allOk = true;
      for (const check of checks) {
        const icon =
          check.status === "ok" ? "OK" :
          check.status === "missing" ? "MISSING" :
          check.status === "degraded" ? "DEGRADED" : "ERROR";
        lines.push(`**${check.component}**: ${icon} — ${check.detail}`);
        if (check.action) {
          lines.push(`  -> ${check.action}`);
          allOk = false;
        }
      }

      lines.push("");

      if (onDeviceModels.length > 0) {
        lines.push("### On-Device Models\n");
        for (const m of onDeviceModels) {
          const label = m.tag ? `${m.name} (${m.tag})` : m.name;
          lines.push(
            `**${label}**: served context window: ${m.servedContextWindow} tokens`
          );
        }
        lines.push("");
      }

      if (allOk) {
        lines.push("All components healthy. All tools are available.");
        if (tier === "free") {
          lines.push(
            "\nSome tools require Pro. Upgrade at: https://pidgeon.health/upgrade"
          );
        }
      } else {
        lines.push("### Setup Instructions\n");

        const cliCheck = checks.find((c) => c.component === "Pidgeon CLI");
        const bridgeCheck = checks.find((c) => c.component === "Pidgeon Bridge");
        const dotnetCheck = checks.find((c) => c.component === ".NET SDK");

        if (dotnetCheck?.status === "missing") {
          lines.push("1. **Install .NET 8 SDK**: https://dotnet.microsoft.com/download/dotnet/8.0");
          lines.push("2. **Install Pidgeon CLI**: `dotnet tool install --global Pidgeon.CLI --version 0.1.0-beta.1`");
        } else if (cliCheck?.status === "missing") {
          lines.push("1. **Install Pidgeon CLI**: `dotnet tool install --global Pidgeon.CLI --version 0.1.0-beta.1`");
        }

        if (mode === "bridge" && bridgeCheck?.status === "missing") {
          lines.push(
            `${dotnetCheck?.status === "missing" ? "3" : "2"}. **Start the Bridge** (for Pro tools): ` +
              "open a Pidgeon desktop app (Post, Flock, Loft, or Migrate) — it runs the Bridge"
          );
          lines.push(
            "\n   Or switch to CLI mode (free tools only) by setting `PIDGEON_MODE=cli` " +
              "in your MCP server configuration."
          );
        }

        lines.push("\nAfter fixing, restart your MCP client to reconnect.");
      }

      // Mode explanation
      lines.push("\n### Mode Reference\n");
      lines.push("- **CLI mode** (`PIDGEON_MODE=cli`): Tools shell out to `pidgeon` CLI. " +
        "All free tools work. Some Pro tools have limited functionality.");
      lines.push("- **Bridge mode** (`PIDGEON_MODE=bridge`, default): Tools call the Pidgeon Bridge REST API. " +
        "Full feature set including Pro tools, diff, workflows, and Loft monitoring.");

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  };
}
