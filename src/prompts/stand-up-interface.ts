// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { PromptDefinition } from "./debug.js";

/**
 * W1 — Stand up a conformant test interface, end-to-end.
 * The lifecycle's load-bearing job: generate vendor-shaped messages, prove they
 * validate, prove the FHIR side passes CMS-0057-F conformance, deliver them.
 * Chains generate_message → validate_message → conform → send_message, looping
 * generate→validate until clean and gating the send on the conformance result.
 */
const argsSchema = z.object({
  messageType: z
    .string()
    .describe("HL7 message type to stand up, e.g. 'ADT^A01' or 'ORU^R01'."),
  vendor: z
    .string()
    .optional()
    .describe("Vendor profile to shape and validate against, e.g. 'epic'."),
  endpoint: z
    .string()
    .optional()
    .describe("FHIR endpoint to prove CMS-0057-F conformance against (enables the conform gate)."),
  destination: z
    .string()
    .optional()
    .describe("SFTP/Mirth pickup path to deliver the validated batch to."),
});

export function createStandUpInterfacePrompt(): PromptDefinition {
  return {
    name: "stand_up_interface",
    description:
      "Stand up a conformant test interface end-to-end: generate vendor-shaped messages, validate " +
      "them, prove the FHIR side passes CMS-0057-F conformance, and deliver them to the pickup folder.",
    argsSchema,
    handler: (args) => {
      const { messageType, vendor, endpoint, destination } = args;

      const userContent = [
        `I need to stand up a new ${messageType} interface and prove it works before go-live.`,
        ...(vendor ? [`Vendor profile: ${vendor}.`] : []),
        ...(endpoint ? [`FHIR endpoint to prove conformance against: ${endpoint}.`] : []),
        ...(destination ? [`Deliver the validated batch to: ${destination}.`] : []),
      ].join("\n");

      const assistantContent = [
        `I'll stand up the ${messageType} interface end-to-end. Here's the orchestration:`,
        "",
        "**Step 1: Generate vendor-shaped messages**",
        `I'll use \`generate_message\` for ${messageType}${vendor ? ` shaped by the ${vendor} profile` : ""}, ` +
          "picking the right HL7 version for the destination.",
        "",
        "**Step 2: Validate (strict + profile)**",
        "`validate_message` in strict mode" + (vendor ? ` against the ${vendor} profile` : "") +
          ". On any structured error I'll either regenerate or call `refine_hl7_segment` to fix the offending " +
          "segment, then re-validate — I only proceed once it's clean.",
        "",
        ...(endpoint
          ? [
              "**Step 3: Prove FHIR conformance (CMS-0057-F gate)**",
              `\`conform\` against ${endpoint}. A non-zero conformance result (or a must-support gap in \`ci\` mode) ` +
                "blocks the delivery — I won't send a batch that fails the spec.",
              "",
            ]
          : [
              "**Step 3: Conformance gate (optional)**",
              "No FHIR endpoint given, so I'll skip the `conform` gate. Provide an endpoint to prove CMS-0057-F readiness.",
              "",
            ]),
        "**Step 4: Deliver**",
        destination
          ? `\`send_message\` to ${destination} once everything above is green.`
          : "`send_message` to your SFTP/Mirth pickup folder once everything above is green (give me a destination).",
        "",
        "Each step's structured output drives the next — I'll show you the validation and conformance scorecards as I go. Starting with generation now...",
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
