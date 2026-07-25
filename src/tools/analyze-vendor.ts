// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";

const inputSchema = z.object({
  messages: z
    .string()
    .describe(
      "Multiple HL7 sample messages separated by blank lines. " +
      "Feed 3-5 messages from the same vendor for accurate pattern detection."
    ),
  vendorName: z
    .string()
    .optional()
    .describe(
      "Optional vendor name hint (e.g., 'epic', 'cerner', 'meditech'). " +
      "If omitted, the vendor is auto-detected from message patterns."
    ),
});

export function createAnalyzeVendorTool(): ToolDefinition {
  return {
    name: "analyze_vendor_pattern",
    requiredTier: "pro",
    // Read-only over MCP: this projection analyzes and returns patterns; it does
    // not pass `save`, so no vendor profile is persisted (the CLI `--save` path
    // is the write surface). readOnlyHint:true — safe to retry.
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Analyze sample HL7 messages to detect vendor-specific patterns " +
      "(field population frequency, ID formats, Z-segments, encoding conventions). " +
      "Produces a vendor profile that can be used for targeted validation and generation. " +
      "Feed 3-5 sample messages for accurate detection.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      // Split on double-newlines (blank line separators between messages)
      const messageList = parsed.messages
        .split(/\n\s*\n/)
        .map((m) => m.trim())
        .filter((m) => m.length > 0);

      if (messageList.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No messages found. Separate multiple messages with blank lines.",
            },
          ],
        };
      }

      let result;
      try {
        result = await transport.analyzeVendorPattern(messageList, {
          vendor: parsed.vendorName,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error analyzing vendor patterns: ${message}`,
            },
          ],
        };
      }

      const lines: string[] = [];

      lines.push("Vendor Pattern Analysis");
      lines.push("─".repeat(50));
      lines.push(`Messages analyzed: ${messageList.length}`);
      if (result.vendor) {
        lines.push(`Detected vendor: ${result.vendor}`);
      }
      lines.push(`Patterns found: ${result.patterns.length}`);
      lines.push("");

      if (result.patterns.length > 0) {
        lines.push(
          `${"Field".padEnd(20)} ${"Frequency".padEnd(12)} ${"Example"}`
        );
        lines.push("─".repeat(60));

        for (const pattern of result.patterns) {
          const field = pattern.field.substring(0, 20).padEnd(20);
          const freq = `${Math.round(pattern.frequency * 100)}%`.padEnd(12);
          const example = pattern.example ?? "";
          lines.push(`${field} ${freq} ${example}`);
        }
      }

      lines.push("");
      lines.push(result.summary);

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n").trimEnd(),
          },
        ],
      };
    },
  };
}
