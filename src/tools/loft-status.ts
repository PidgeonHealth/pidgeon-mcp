// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { withSuccessEnvelope } from "./format.js";

const inputSchema = z.object({
  since: z
    .string()
    .optional()
    .describe(
      "Time window for status data (e.g., '24h', '1h', '7d'). " +
      "Defaults to the last 24 hours if not specified."
    ),
  path: z
    .string()
    .optional()
    .describe("Monitored directory path to filter status for a specific interface."),
});

const STATUS_ICONS: Record<string, string> = {
  healthy: "[OK]",
  warning: "[!!]",
  error: "[XX]",
  unknown: "[??]",
};

export function createLoftStatusTool(): ToolDefinition {
  return {
    name: "loft_status",
    requiredTier: "pro",
    annotations: { readOnlyHint: true, openWorldHint: false },
    // The Loft watch step of the cross-app journey (H-26). Terminal: its interface
    // health/findings are the journey's terminal artifact, read by the coordinating
    // agent — no downstream tool consumes them (feeds is empty). No message content
    // rides this envelope (H-33) — only per-interface health metrics.
    outputEnvelope: {
      keys: [
        { key: "interfaceCount", description: "Number of monitored interfaces reported." },
        { key: "interfaces", description: "Per-interface health rows: name, status, messageCount, errorRate — no message content (H-33)." },
        { key: "health", description: "Roll-up counts by status, e.g. {\"healthy\": 1, \"warning\": 1}." },
        { key: "summary", description: "Human summary line for the watch window." },
      ],
      feeds: [],
    },
    description:
      "Check the health status of monitored healthcare interfaces via Pidgeon Loft. " +
      "Shows per-interface message counts, error rates, and alerts. " +
      "Use to check interface health from your AI editor without switching to a dashboard.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      let result;
      try {
        result = await transport.loftStatus({
          since: parsed.since,
          path: parsed.path,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error retrieving Loft status: ${message}`,
            },
          ],
        };
      }

      const lines: string[] = [];

      lines.push("Loft Interface Health Status");
      lines.push("─".repeat(60));
      if (parsed.since) {
        lines.push(`Time window: ${parsed.since}`);
      }
      lines.push(`Interfaces monitored: ${result.interfaces.length}`);
      lines.push("");

      // Roll-up counts by status — drives both the human "Summary" line and the
      // machine envelope's `health` key. Empty roster yields {}.
      const health: Record<string, number> = {};
      for (const iface of result.interfaces) {
        health[iface.status] = (health[iface.status] ?? 0) + 1;
      }

      if (result.interfaces.length > 0) {
        lines.push(
          `${"Status".padEnd(8)} ${"Interface".padEnd(25)} ${"Messages".padEnd(12)} ${"Error Rate".padEnd(12)} ${"Last Message"}`
        );
        lines.push("─".repeat(75));

        for (const iface of result.interfaces) {
          const icon = STATUS_ICONS[iface.status] ?? "[??]";
          const name = iface.name.substring(0, 25).padEnd(25);
          const msgs = iface.messageCount !== undefined
            ? String(iface.messageCount).padEnd(12)
            : "—".padEnd(12);
          const errRate = iface.errorRate !== undefined
            ? `${(iface.errorRate * 100).toFixed(1)}%`.padEnd(12)
            : "—".padEnd(12);
          const lastMsg = iface.lastMessage ?? "—";
          lines.push(`${icon}  ${name} ${msgs} ${errRate} ${lastMsg}`);
        }

        lines.push("");
        const parts = Object.entries(health)
          .map(([status, count]) => `${count} ${status}`)
          .join(", ");
        lines.push(`Summary: ${parts}`);
      } else {
        lines.push("No interfaces currently monitored.");
      }

      lines.push("");
      lines.push(result.summary);

      // Machine envelope (H-16/H-26): the terminal artifact of the watch step — an
      // agent branches on per-interface status without parsing the table. Carries
      // health metrics only, never message content (H-33).
      return withSuccessEnvelope(lines.join("\n").trimEnd(), {
        interfaceCount: result.interfaces.length,
        interfaces: result.interfaces,
        health,
        summary: result.summary,
      });
    },
  };
}
