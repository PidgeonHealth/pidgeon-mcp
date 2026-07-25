// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";

const inputSchema = z.object({
  message: z
    .string()
    .describe("The HL7 message to send. Paste the full pipe-delimited message."),
  destination: z
    .string()
    .describe(
      "Delivery destination. Supports SFTP URIs (e.g., 'sftp://user@host/path') " +
      "and local file paths (e.g., '/path/to/mirth/pickup')."
    ),
  filename: z
    .string()
    .optional()
    .describe(
      "Optional filename for the delivered message. " +
      "If omitted, a timestamped filename is generated automatically."
    ),
  idempotencyKey: z
    .string()
    .optional()
    .describe(
      "Optional idempotency key. Safe to retry a send with the same key after an " +
      "ambiguous failure: the same delivery will not be repeated — the recorded " +
      "outcome is returned instead (Bridge mode)."
    ),
});

export function createSendTool(): ToolDefinition {
  return {
    name: "send_message",
    requiredTier: "pro",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description:
      "Send an HL7 message to an SFTP destination or local file path. " +
      "Use for delivering test messages to Mirth pickup folders, SFTP endpoints, " +
      "or local directories during go-live testing. " +
      "Returns confirmation of delivery or error details. " +
      "Pass an `idempotencyKey` to make retries safe — a repeat with the same key replays the recorded delivery instead of re-sending.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      let result;
      try {
        result = await transport.sendMessage(parsed.message, parsed.destination, {
          filename: parsed.filename,
          idempotencyKey: parsed.idempotencyKey,
          protocol: parsed.destination.startsWith("sftp://") ? "sftp" : "local",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error sending message: ${message}`,
            },
          ],
        };
      }

      const lines: string[] = [];

      if (result.success) {
        lines.push(result.replayed
          ? "Message Delivery Replayed (idempotent retry — not delivered again)"
          : "Message Delivered Successfully");
        lines.push("─".repeat(40));
        lines.push(`Destination: ${result.destination}`);
        if (result.filename) lines.push(`Filename: ${result.filename}`);
      } else {
        lines.push("Message Delivery Failed");
        lines.push("─".repeat(40));
        lines.push(`Destination: ${result.destination}`);
      }

      lines.push("");
      lines.push(result.summary);

      lines.push("");
      lines.push(
        "WARNING: This tool delivers messages to real destinations. " +
        "Verify the destination path before use in production environments."
      );

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
