// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { PromptDefinition } from "./debug.js";

const argsSchema = z.object({
  vendor: z
    .string()
    .describe("The EHR vendor (e.g., 'Epic', 'Cerner', 'Meditech')."),
  interfaceType: z
    .string()
    .describe("The type of interface (e.g., 'ADT', 'Lab Results', 'Pharmacy Orders')."),
  messageTypes: z
    .string()
    .optional()
    .describe(
      "Comma-separated list of specific message types to test (e.g., 'ADT^A01,ADT^A03,ADT^A08')."
    ),
});

// Default message types per interface category.
const DEFAULT_MESSAGE_TYPES: Record<string, string[]> = {
  adt: ["ADT^A01", "ADT^A03", "ADT^A08", "ADT^A04", "ADT^A40"],
  "lab results": ["ORU^R01"],
  "lab orders": ["ORM^O01", "ORR^O02"],
  "pharmacy orders": ["RDE^O11", "RDS^O13"],
  pharmacy: ["RDE^O11", "RDS^O13"],
  "clinical documents": ["MDM^T02"],
  scheduling: ["SIU^S12", "SIU^S14", "SIU^S15"],
};

function resolveMessageTypes(interfaceType: string, messageTypes?: string): string[] {
  if (messageTypes) {
    return messageTypes.split(",").map((t) => t.trim()).filter(Boolean);
  }
  const key = interfaceType.toLowerCase().trim();
  return DEFAULT_MESSAGE_TYPES[key] ?? [`${interfaceType.toUpperCase()}^A01`];
}

export function createGoLivePrompt(): PromptDefinition {
  return {
    name: "go_live_prep",
    description:
      "Help prepare for an interface go-live with a specific vendor. " +
      "Generates test messages matching the vendor's patterns, validates them, " +
      "and produces a testing checklist.",
    argsSchema,
    handler: (args) => {
      const { vendor, interfaceType, messageTypes } = args;
      const resolvedTypes = resolveMessageTypes(interfaceType, messageTypes);
      const typeList = resolvedTypes.join(", ");
      const vendorNorm = vendor.toLowerCase().replace(/\s+/g, "_");

      const userContent = [
        `I'm preparing for a go-live with ${vendor} for a ${interfaceType} interface.`,
        "",
        "Please help me:",
        `1. Generate test messages for message types: ${typeList}`,
        `2. Validate each message using the '${vendorNorm}' vendor profile`,
        "3. Identify any vendor-specific field patterns or known quirks",
        "4. Produce a testing checklist I can work through on go-live day",
        ...(messageTypes
          ? [`\nSpecific message types requested: ${messageTypes}`]
          : []),
      ].join("\n");

      const assistantContent = [
        `I'll help you prepare for the ${vendor} ${interfaceType} go-live. Here's my plan:`,
        "",
        "**Phase 1: Generate vendor-specific test messages**",
        `I'll use \`generate_message\` with \`vendor: "${vendorNorm}"\` to produce messages that match ` +
          `${vendor}'s known field patterns, MRN formats, and encoding conventions.`,
        "",
        `Message types to cover: ${typeList}`,
        "",
        "**Phase 2: Validate against vendor profile**",
        `Each generated message will be validated with \`validate_message\` in compatibility mode ` +
          `using the ${vendor} vendor profile. I'll flag any fields that ${vendor} typically requires ` +
          "that are missing, or values that don't match their known patterns.",
        "",
        "**Phase 3: Vendor-specific quirks**",
        `Known ${vendor} interface characteristics to watch for:`,
        "- Patient identifier format (PID.3 structure and assigning authority)",
        "- Sending application name in MSH.3",
        "- Required vs. optional fields that differ from the base HL7 spec",
        "- Z-segment usage for site-specific extensions",
        "- Date/time format conventions",
        "",
        "**Phase 4: Go-live testing checklist**",
        "After validation, I'll produce a structured checklist covering:",
        "- [ ] Test message sent and acknowledged (MSH.9, MSA.1=AA)",
        "- [ ] Patient demographics populated correctly (PID.3, PID.5, PID.7, PID.8)",
        "- [ ] Message type and trigger event correct (MSH.9)",
        "- [ ] Date/time fields in expected format (MSH.7, PV1.44, PV1.45)",
        "- [ ] Required segments present for message type",
        "- [ ] Vendor-specific required fields populated",
        "- [ ] Integration engine routing rules tested",
        "- [ ] Error handling verified (send a deliberately malformed message, confirm NAK)",
        "",
        "Let me start generating the test messages...",
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
