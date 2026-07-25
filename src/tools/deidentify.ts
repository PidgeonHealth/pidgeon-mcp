// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";

const inputSchema = z.object({
  message: z
    .string()
    .describe(
      "The raw HL7 message to de-identify. Paste the full pipe-delimited message."
    ),
  dateShift: z
    .string()
    .optional()
    .describe(
      "Shift dates by an offset (e.g., '30d' for 30 days, '-14d' for minus 14 days)."
    ),
  salt: z
    .string()
    .optional()
    .describe(
      "Salt for deterministic hashing. Use the same salt to get consistent de-identification across messages."
    ),
});

export function createDeidentifyTool(): ToolDefinition {
  return {
    name: "deidentify_message",
    requiredTier: "free",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "De-identify an HL7 message by removing PHI (patient names, DOB, MRN, SSN, addresses). " +
      "Returns the de-identified message with a summary of fields modified. " +
      "Use for creating safe test data from production messages without exposing real patient information. " +
      "Deterministic by `salt` — the same salt yields the same de-identified output, so retries are safe.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      let result;
      try {
        result = await transport.deidentify(parsed.message, {
          dateShift: parsed.dateShift,
          salt: parsed.salt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error de-identifying message: ${message}`,
            },
          ],
        };
      }

      const lines: string[] = [];

      lines.push("De-identification Complete");
      lines.push("─".repeat(40));
      lines.push(`Fields modified: ${result.fieldsModified}`);
      if (parsed.dateShift) {
        lines.push(`Date shift: ${parsed.dateShift}`);
      }
      if (parsed.salt) {
        lines.push(`Salt: (provided)`);
      }
      lines.push("");
      lines.push("De-identified Message:");
      lines.push("─".repeat(40));
      lines.push(result.deidentified);
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
