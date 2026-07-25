// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { withSuccessEnvelope } from "./format.js";

const inputSchema = z.object({
  scenario: z
    .string()
    .describe(
      "Built-in scenario name (e.g., 'admission-with-labs', 'sepsis-cohort'). " +
      "If the name is not recognized, the error lists the available scenarios. " +
      "Defines the sequence of clinical steps to generate as one coherent patient cohort."
    ),
  vendor: z
    .string()
    .optional()
    .describe("Apply vendor-specific patterns to all generated messages (e.g., 'epic', 'cerner')."),
  count: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(1)
    .describe("Number of times to repeat the scenario with different patient data."),
});

export function createWorkflowTool(): ToolDefinition {
  return {
    name: "run_workflow",
    requiredTier: "pro",
    // Generate-class (not read-only); no seed input today, so each run yields a
    // fresh cohort — not byte-reproducible, hence idempotentHint:false.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputEnvelope: {
      keys: [
        { key: "stepCount", description: "Number of clinical steps generated." },
        { key: "steps", description: "The ordered steps, each { name, messageType, message } — feed a step's message into validate_message / send_message." },
      ],
      feeds: ["validate_message", "send_message"],
    },
    description:
      "Execute a multi-step clinical scenario (e.g., admission-with-labs: Admit -> Lab Order -> Lab Result) " +
      "as one coherent patient cohort. Returns the sequence of HL7 messages, all sharing one patient's " +
      "demographics and identifiers across steps. Use for testing complete clinical pathways, not just " +
      "individual message types. For a single standalone message use generate_message instead, not run_workflow. " +
      "Each run generates a fresh patient cohort. Optionally apply a vendor's compliance rules to every message.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      let result;
      try {
        result = await transport.runWorkflow(parsed.scenario, {
          vendor: parsed.vendor,
          count: parsed.count,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error running workflow: ${message}`,
            },
          ],
        };
      }

      const lines: string[] = [];
      const separator = "─".repeat(60);

      lines.push("Workflow Execution Results");
      lines.push(separator);
      lines.push(`Steps completed: ${result.steps.length}`);
      lines.push("");

      for (let i = 0; i < result.steps.length; i++) {
        const step = result.steps[i];
        lines.push(`Step ${i + 1}: ${step.name} (${step.messageType})`);
        lines.push(separator);
        lines.push(step.message);
        lines.push("");
      }

      lines.push(result.summary);

      // Machine envelope: the ordered steps by value, so an agent chains each
      // generated message into validate_message / send_message without slicing
      // the separators out of the prose above (H-16). Keys are stable API.
      return withSuccessEnvelope(lines.join("\n").trimEnd(), {
        stepCount: result.steps.length,
        steps: result.steps,
      });
    },
  };
}
