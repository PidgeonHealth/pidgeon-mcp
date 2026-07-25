// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";

export interface PromptDefinition {
  name: string;
  description: string;
  argsSchema: z.ZodObject<any>;
  handler: (args: Record<string, string>) => {
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  };
}

const argsSchema = z.object({
  message: z
    .string()
    .describe("The HL7 message that is failing validation."),
  errorContext: z
    .string()
    .optional()
    .describe(
      "Additional context about where/how this error occurred (e.g., 'Epic rejected this in the ADT feed')."
    ),
});

export function createDebugPrompt(): PromptDefinition {
  return {
    name: "debug_hl7_error",
    description:
      "Walk through debugging an HL7 validation failure step by step. " +
      "Validates the message, explains each error in plain English, identifies the root cause, " +
      "and suggests a corrected version.",
    argsSchema,
    handler: (args) => {
      const { message, errorContext } = args;

      const userContent = [
        "I have an HL7 message that's failing validation. Please help me debug it.",
        "",
        "Message:",
        "```",
        message,
        "```",
        ...(errorContext
          ? ["", "Additional context:", errorContext]
          : []),
      ].join("\n");

      const assistantContent = [
        "I'll help you debug this HL7 message. Let me work through it systematically.",
        "",
        "**Step 1: Validate the message**",
        "I'll start with `validate_message` in compatibility mode to get the full list of errors " +
          "without rejecting the message for minor real-world deviations.",
        "",
        "**Step 2: Explain each error**",
        "For every error and warning, I'll explain:",
        "- What field or segment the rule applies to",
        "- Why the rule exists in the HL7 spec",
        "- What value is wrong and what a valid value looks like",
        "",
        "**Step 3: Identify the root cause**",
        "Most HL7 validation failures have one of a handful of root causes:",
        "- Missing required field (PID.3, MSH.9, MSH.12 are the most common)",
        "- Wrong data type format (dates as YYYYMMDD not YYYY-MM-DD, coded elements missing system)",
        "- Encoding character issues (special characters unescaped, wrong field separator)",
        "- Version mismatch (v2.3 message sent to v2.7 endpoint)",
        "- Vendor deviation (site-specific Z-segment or non-standard field usage)",
        "",
        "**Step 4: Suggest fixes**",
        "I'll provide specific field corrections with before/after examples.",
        "",
        "**Step 5: Generate a corrected version (if requested)**",
        "If the fixes are straightforward, I can use `generate_message` to produce a corrected " +
          "version of the same message type with proper field values.",
        "",
        "Let me begin by validating the message now...",
      ].join("\n");

      return {
        messages: [
          { role: "user", content: userContent },
          { role: "assistant", content: assistantContent },
        ],
      };
    },
  };
}
