// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { errorResult } from "./format.js";

// The Bridge surfaces these when the on-device AI model isn't set up yet
// (AIProviderFactory: "No settings found for active provider..."). Detecting the
// signal lets refine degrade to an actionable on-device setup hint instead of a
// raw error — the "no PHI to cloud, run one command" posture.
const NO_MODEL_SIGNAL = /no settings (found|configured) for active provider|ai configure|ai download|provider .*not configured|ollama|no on-device model/i;

const inputSchema = z.object({
  originalMessage: z
    .string()
    .describe("The full original HL7 message."),
  segmentIndex: z
    .number()
    .int()
    .describe("The 0-based index of the target segment within the message."),
  segmentContent: z
    .string()
    .describe("The exact text of the segment to refine (e.g. 'OBX|1|NM|...')."),
  prompt: z
    .string()
    .describe("The refinement instruction (e.g., 'Change lab value to 22.4')."),
  profile: z
    .string()
    .optional()
    .describe("Apply a vendor profile (e.g. 'epic') for strict conformance during self-healing."),
});

export function createRefineHl7SegmentTool(): ToolDefinition {
  return {
    name: "refine_hl7_segment",
    requiredTier: "pro",
    // Bounded self-heal — runs an AI steer + re-validate loop, does not persist.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description:
      "Apply a natural-language instruction to one HL7 segment in place, then validate and " +
      "self-heal the result against the standard (and a vendor profile if given). Returns the " +
      "refined message plus whether self-healing reached full compliance. " +
      "Runs a bounded server-side self-heal loop (surfaced as retryCount) and does not persist changes — safe to call again.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      let result;
      try {
        result = await transport.refine(parsed.originalMessage, parsed.prompt, {
          originalMessage: parsed.originalMessage,
          segmentContent: parsed.segmentContent,
          segmentIndex: parsed.segmentIndex,
          profile: parsed.profile,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (NO_MODEL_SIGNAL.test(message)) {
          return errorResult(
            "AI refinement needs an on-device model. Run `pidgeon ai download qwen3-4b` once to set up the " +
              "bundled on-device model — no API key, no PHI leaves your machine — or configure BYOK with " +
              "`pidgeon ai configure`. In the meantime, the free `explain_error` tool gives you the full " +
              "diagnosis and the exact fix with no model required.",
            "TOOL_ERROR",
            { remediation: "on-device-model-required", setupCommand: "pidgeon ai download qwen3-4b" }
          );
        }
        return errorResult(`Error refining segment: ${message}`);
      }

      const separator = "─".repeat(60);
      const lines: string[] = [];

      lines.push(result.isValid ? "Refinement: valid (compliant)" : "Refinement: invalid (best effort)");
      lines.push(`Self-healing passes: ${result.retryCount}`);
      lines.push(separator);
      lines.push(result.refinedContent);

      if (!result.isValid && result.errors.length > 0) {
        lines.push("");
        lines.push("Remaining validation errors:");
        for (const error of result.errors) {
          lines.push(`  - ${error}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n").trimEnd() }],
      };
    },
  };
}
